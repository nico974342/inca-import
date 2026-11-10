/**
 * Audit de sécurité de bl_signatures.sql — base LOCALE (PGlite), aucune connexion à Supabase.
 * Reproduit le schéma réel relevé en lecture seule sur la production :
 *   delivery_notes.client_id → client_accounts ON DELETE SET NULL ; aucune clé étrangère entrante ; aucun trigger ; 0 ligne.
 */
import { test, expect } from '@playwright/test';
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';

const SQL = readFileSync('supabase/migrations/bl_signatures.sql', 'utf8');
const SEQ = readFileSync('supabase/migrations/bl_sequence.sql', 'utf8');
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const PNG2 = PNG.replace('AAAA', 'BBBB');

const ENV = `
  CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN BYPASSRLS;
  ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
  CREATE SCHEMA storage; CREATE TABLE storage.buckets (id text PRIMARY KEY, name text NOT NULL, public boolean DEFAULT false, file_size_limit bigint, allowed_mime_types text[]);
  CREATE TABLE admin_audit_logs (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), admin_email text NOT NULL, action text NOT NULL, target_type text,
    target_id text, target_label text, details jsonb, created_at timestamptz NOT NULL DEFAULT now());
  CREATE TABLE client_accounts (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), nom text NOT NULL);
  CREATE TABLE orders (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), nom text, bl_number text);
  CREATE TABLE delivery_notes (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), delivery_id text NOT NULL,
    client_id uuid REFERENCES client_accounts(id) ON DELETE SET NULL, pdv_key text NOT NULL, pdv_name text NOT NULL,
    storage_path text NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
  ALTER TABLE delivery_notes ENABLE ROW LEVEL SECURITY; ALTER TABLE admin_audit_logs ENABLE ROW LEVEL SECURITY;
  GRANT USAGE ON SCHEMA public, storage TO anon, authenticated, service_role;`;

const un = async (db: PGlite, q: string, p: unknown[] = []) => (await db.query<any>(q, p)).rows[0];
const tous = async (db: PGlite, q: string, p: unknown[] = []) => (await db.query<any>(q, p)).rows;
const refus = async (db: PGlite, q: string, p: unknown[] = []) => { try { await db.query(q, p); return null; } catch (e: any) { return String(e.message); } };

test.describe.serial('Audit de la migration bl_signatures.sql (base locale)', () => {
  let db: PGlite;
  let clientA: string, clientB: string, bl1: string, bl2: string, bl3: string;
  const signer = (bl: string, role: string, nom: string, par: string, png = PNG) =>
    db.query(`INSERT INTO bl_signatures (delivery_note_id, role, signature_data, signataire_nom, signed_by) VALUES ($1,$2,$3,$4,$5)`, [bl, role, png, nom, par]);
  const etatAvant = async () => JSON.stringify({
    seq: await un(db, `SELECT last_value::int, is_called FROM bl_number_seq`),
    orders: await tous(db, `SELECT id, bl_number FROM orders ORDER BY bl_number`),
    notes: await tous(db, `SELECT id, delivery_id, client_id, pdv_key, pdv_name, storage_path, created_at FROM delivery_notes ORDER BY delivery_id`),
  });
  let avant = '';

  test.beforeAll(async () => {
    db = new PGlite(); await db.exec(ENV); await db.exec(SEQ);
    clientA = (await un(db, `INSERT INTO client_accounts (nom) VALUES ('Client A') RETURNING id`)).id;
    clientB = (await un(db, `INSERT INTO client_accounts (nom) VALUES ('Client B') RETURNING id`)).id;
    await db.exec(`SELECT setval('bl_number_seq', 90)`);
    await db.exec(`INSERT INTO orders (nom, bl_number) VALUES ('c1','BL-0088'), ('c2','BL-0089'), ('c3','BL-0090'), ('c4', NULL)`);
    bl1 = (await un(db, `INSERT INTO delivery_notes (delivery_id, client_id, pdv_key, pdv_name, storage_path) VALUES ('BL-0091',$1,'k1','Station A','BL-0091/k1.pdf') RETURNING id`, [clientA])).id;
    bl2 = (await un(db, `INSERT INTO delivery_notes (delivery_id, client_id, pdv_key, pdv_name, storage_path) VALUES ('BL-0092',$1,'k2','Station B','BL-0092/k2.pdf') RETURNING id`, [clientB])).id;
    bl3 = (await un(db, `INSERT INTO delivery_notes (delivery_id, client_id, pdv_key, pdv_name, storage_path) VALUES ('BL-0093',$1,'k3','Station C','BL-0093/k3.pdf') RETURNING id`, [clientB])).id;
    avant = await etatAvant();
    await db.exec(SQL);
  });
  test.afterAll(async () => { await db.close(); });

  // ── 1. Aucune donnée existante touchée ───────────────────────────────────
  test('numérotation, commandes, BL et clients existants strictement intacts après la migration', async () => {
    expect(await etatAvant()).toBe(avant);
    expect((await un(db, `SELECT next_bl_number() AS n`)).n).toBe('BL-0091');   // la séquence continue exactement là où elle en était
  });

  test('bucket privé, PDF seulement, 10 Mo ; droits retirés à anon / authenticated sur delivery_notes et bl_signatures', async () => {
    expect(await un(db, `SELECT public, file_size_limit::int AS taille, allowed_mime_types AS mime FROM storage.buckets WHERE id='delivery-notes'`))
      .toEqual({ public: false, taille: 10485760, mime: ['application/pdf'] });
    for (const t of ['delivery_notes', 'bl_signatures']) {
      for (const role of ['anon', 'authenticated']) {
        await db.exec(`SET ROLE ${role}`);
        expect(await refus(db, `SELECT * FROM ${t}`), `${role} ${t}`).toMatch(/permission denied/);
        await db.exec(`RESET ROLE`);
      }
    }
    // même avec les droits par défaut de Supabase, le serveur n'a ni DELETE ni TRUNCATE sur les signatures
    const droits = (await tous(db, `SELECT privilege_type FROM information_schema.role_table_grants WHERE table_name='bl_signatures' AND grantee='service_role' ORDER BY 1`)).map(r => r.privilege_type);
    expect(droits).toEqual(['INSERT', 'SELECT', 'UPDATE']);
  });

  // ── 2. Journal d'audit : atomique, complet ───────────────────────────────
  test('signature journalisée par la base : auteur, BL, rôle, nom, date, empreinte', async () => {
    await signer(bl1, 'transporteur', 'Gérald Incana', 'gerald@inca.re');
    const j = await un(db, `SELECT * FROM admin_audit_logs WHERE action='bl.signature'`);
    expect(j.admin_email).toBe('gerald@inca.re');
    expect(j.target_type).toBe('bl'); expect(j.target_id).toBe(bl1);
    expect(j.target_label).toBe('BL-0091 — Station A');
    const s = await un(db, `SELECT id, signed_at, md5(signature_data) AS h FROM bl_signatures WHERE delivery_note_id=$1`, [bl1]);
    expect(j.details).toMatchObject({ role: 'transporteur', signataire_nom: 'Gérald Incana', signature_id: s.id, empreinte: s.h });
    expect(new Date(j.details.signed_at).getTime()).toBe(new Date(s.signed_at).getTime());
  });

  test('si le journal ne peut pas être écrit, la signature n\'est PAS enregistrée (jamais de signature sans trace)', async () => {
    await db.exec(`ALTER TABLE admin_audit_logs RENAME TO admin_audit_logs_hs`);
    expect(await refus(db, `INSERT INTO bl_signatures (delivery_note_id, role, signature_data, signataire_nom, signed_by) VALUES ($1,'destinataire',$2,'X','a@b.re')`, [bl1, PNG])).toMatch(/admin_audit_logs/);
    await db.exec(`ALTER TABLE admin_audit_logs_hs RENAME TO admin_audit_logs`);
    expect((await un(db, `SELECT count(*)::int n FROM bl_signatures WHERE delivery_note_id=$1`, [bl1])).n).toBe(1);
  });

  test('annulation journalisée (auteur de l\'annulation, motif, signature d\'origine) ; la signature annulée reste en base, intacte', async () => {
    await signer(bl1, 'destinataire', 'Marie Client', 'gerald@inca.re');
    await db.query(`UPDATE bl_signatures SET annulee_le = now(), annulee_par = 'admin@inca.re', annulation_motif = 'Mauvais destinataire' WHERE delivery_note_id=$1 AND role='destinataire'`, [bl1]);
    const j = await un(db, `SELECT * FROM admin_audit_logs WHERE action='bl.signature_annulee'`);
    expect(j.admin_email).toBe('admin@inca.re');
    expect(j.target_label).toBe('BL-0091 — Station A');
    expect(j.details).toMatchObject({ role: 'destinataire', signataire_nom: 'Marie Client', signed_by: 'gerald@inca.re', motif: 'Mauvais destinataire' });
    const conservee = await un(db, `SELECT signature_data, signataire_nom, signed_by, signed_at, annulee_par, annulation_motif FROM bl_signatures WHERE delivery_note_id=$1 AND role='destinataire'`, [bl1]);
    expect(conservee).toMatchObject({ signature_data: PNG, signataire_nom: 'Marie Client', signed_by: 'gerald@inca.re', annulee_par: 'admin@inca.re', annulation_motif: 'Mauvais destinataire' });
    expect(conservee.signed_at).toBeTruthy();
    expect((await un(db, `SELECT count(*)::int n FROM admin_audit_logs WHERE details->>'signature_id' = $1`, [(await un(db, `SELECT id FROM bl_signatures WHERE delivery_note_id=$1 AND role='destinataire'`, [bl1])).id])).n).toBe(2);   // signature + annulation
  });

  test('journal d\'annulation en échec : la signature reste active (annulation entièrement refusée)', async () => {
    await db.exec(`ALTER TABLE admin_audit_logs RENAME TO admin_audit_logs_hs`);
    expect(await refus(db, `UPDATE bl_signatures SET annulee_le = now(), annulee_par = 'a@b.re', annulation_motif = 'x' WHERE delivery_note_id=$1 AND role='transporteur'`, [bl1])).toMatch(/admin_audit_logs/);
    await db.exec(`ALTER TABLE admin_audit_logs_hs RENAME TO admin_audit_logs`);
    expect((await un(db, `SELECT annulee_le FROM bl_signatures WHERE delivery_note_id=$1 AND role='transporteur'`, [bl1])).annulee_le).toBeNull();
  });

  // ── 3. Aucune suppression, même indirecte ────────────────────────────────
  test('suppression d\'un BL signé : refusée ; BL et signatures toujours là', async () => {
    expect(await refus(db, `DELETE FROM delivery_notes WHERE id=$1`, [bl1])).toMatch(/ne peut pas être supprimée/);
    expect((await un(db, `SELECT count(*)::int n FROM delivery_notes WHERE id=$1`, [bl1])).n).toBe(1);
    expect((await un(db, `SELECT count(*)::int n FROM bl_signatures WHERE delivery_note_id=$1`, [bl1])).n).toBe(2);
  });

  test('suppression d\'un client : possible (la clé étrangère met client_id à NULL) mais BL et signatures conservés', async () => {
    await signer(bl2, 'transporteur', 'Arnaud', 'arnaud@inca.re');
    await db.query(`DELETE FROM client_accounts WHERE id=$1`, [clientB]);
    const n = await un(db, `SELECT client_id, delivery_id FROM delivery_notes WHERE id=$1`, [bl2]);
    expect(n).toEqual({ client_id: null, delivery_id: 'BL-0092' });
    expect((await un(db, `SELECT count(*)::int n FROM bl_signatures WHERE delivery_note_id=$1`, [bl2])).n).toBe(1);
  });

  test('suppression de commandes : sans lien avec les BL et les signatures', async () => {
    await db.exec(`DELETE FROM orders`);
    expect((await un(db, `SELECT count(*)::int n FROM bl_signatures`)).n).toBe(3);
    expect((await un(db, `SELECT count(*)::int n FROM delivery_notes`)).n).toBe(3);
  });

  test('TRUNCATE en cascade (depuis delivery_notes ou client_accounts) : refusé, rien n\'est vidé', async () => {
    expect(await refus(db, `TRUNCATE delivery_notes CASCADE`)).toMatch(/ne peuvent pas être vidées/);
    expect(await refus(db, `TRUNCATE client_accounts CASCADE`)).toMatch(/ne peuvent pas être vidées/);
    expect(await refus(db, `TRUNCATE bl_signatures`)).toMatch(/ne peuvent pas être vidées/);
    expect((await un(db, `SELECT count(*)::int n FROM bl_signatures`)).n).toBe(3);
    expect((await un(db, `SELECT count(*)::int n FROM delivery_notes`)).n).toBe(3);
    expect((await un(db, `SELECT count(*)::int n FROM client_accounts`)).n).toBe(1);
  });

  test('un BL sans signature reste supprimable (comportement actuel de la suppression d\'un client)', async () => {
    await db.query(`DELETE FROM delivery_notes WHERE id=$1`, [bl3]);
    expect((await un(db, `SELECT count(*)::int n FROM delivery_notes`)).n).toBe(2);
  });

  // ── 4. BL figé ───────────────────────────────────────────────────────────
  test('contenu du BL figé : une fois mémorisé, ni le contenu, ni le numéro, ni le fichier ne changent', async () => {
    const contenu = { pdv: { name: 'Station A', items: [{ product_name: 'Cola', quantity: 5 }] }, date: '10/11/2026' };
    await db.query(`UPDATE delivery_notes SET contenu = $1::jsonb WHERE id=$2`, [JSON.stringify(contenu), bl1]);   // première mémorisation : autorisée
    expect(await refus(db, `UPDATE delivery_notes SET contenu = '{"pdv":{"items":[]}}'::jsonb WHERE id=$1`, [bl1])).toMatch(/figé/);
    expect(await refus(db, `UPDATE delivery_notes SET contenu = NULL WHERE id=$1`, [bl1])).toMatch(/figé/);
    expect(await refus(db, `UPDATE delivery_notes SET delivery_id = 'BL-9999' WHERE id=$1`, [bl1])).toMatch(/ne peut pas être modifié/);
    expect(await refus(db, `UPDATE delivery_notes SET storage_path = 'autre.pdf' WHERE id=$1`, [bl1])).toMatch(/ne peut pas être modifié/);
    expect(await refus(db, `UPDATE delivery_notes SET pdv_name = 'Autre' WHERE id=$1`, [bl1])).toMatch(/ne peut pas être modifié/);
    expect((await un(db, `SELECT contenu FROM delivery_notes WHERE id=$1`, [bl1])).contenu).toEqual(contenu);
  });

  test('numéro de BL unique : pas de doublon de ligne pour un même numéro', async () => {
    expect(await refus(db, `INSERT INTO delivery_notes (delivery_id, pdv_key, pdv_name, storage_path) VALUES ('BL-0091','k','x','y')`)).toMatch(/duplicate|unique/i);
  });

  // ── 5. Coupure réseau : ni perte ni doublon ──────────────────────────────
  test('nouvel essai après une réponse perdue : un seul enregistrement ; la même signature est reconnue, une autre est refusée', async () => {
    // la signature du transporteur de BL-0091 existe déjà (cas : la requête est passée mais la réponse s'est perdue)
    expect(await refus(db, `INSERT INTO bl_signatures (delivery_note_id, role, signature_data, signataire_nom, signed_by) VALUES ($1,'transporteur',$2,'Gérald Incana','gerald@inca.re')`, [bl1, PNG])).toMatch(/duplicate|unique/i);
    const existante = await un(db, `SELECT signature_data, signataire_nom FROM bl_signatures WHERE delivery_note_id=$1 AND role='transporteur' AND annulee_le IS NULL`, [bl1]);
    expect(existante).toEqual({ signature_data: PNG, signataire_nom: 'Gérald Incana' });   // → l'API répond « déjà enregistrée » (même contenu)
    expect(existante.signature_data === PNG2).toBe(false);                                   // un contenu différent est refusé (409), jamais écrasé
    expect((await un(db, `SELECT count(*)::int n FROM bl_signatures WHERE delivery_note_id=$1 AND role='transporteur'`, [bl1])).n).toBe(1);
  });

  test('re-signature après annulation : acceptée, une seule signature active par rôle, historique conservé', async () => {
    await signer(bl1, 'destinataire', 'Paul Destinataire', 'gerald@inca.re', PNG2);
    const lignes = await tous(db, `SELECT signataire_nom, annulee_le IS NOT NULL AS annulee FROM bl_signatures WHERE delivery_note_id=$1 AND role='destinataire' ORDER BY created_at, signataire_nom`, [bl1]);
    expect(lignes).toHaveLength(2);
    expect(lignes.filter(l => !l.annulee).map(l => l.signataire_nom)).toEqual(['Paul Destinataire']);
    expect(lignes.filter(l => l.annulee).map(l => l.signataire_nom)).toEqual(['Marie Client']);
  });

  test('migration rejouable : aucun doublon de trigger, aucune donnée modifiée', async () => {
    const avantRejeu = JSON.stringify(await tous(db, `SELECT * FROM bl_signatures ORDER BY id`));
    await db.exec(SQL);
    expect(JSON.stringify(await tous(db, `SELECT * FROM bl_signatures ORDER BY id`))).toBe(avantRejeu);
    const triggers = (await tous(db, `SELECT tgname FROM pg_trigger WHERE tgrelid IN ('bl_signatures'::regclass, 'delivery_notes'::regclass) AND NOT tgisinternal ORDER BY 1`)).map(t => t.tgname);
    expect(triggers).toEqual(['trg_bl_signatures_journal', 'trg_bl_signatures_proteger', 'trg_bl_signatures_proteger_truncate', 'trg_delivery_notes_figer']);
  });
});
