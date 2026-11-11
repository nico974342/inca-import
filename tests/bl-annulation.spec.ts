/**
 * Annulation d'une signature de BL depuis la fiche Commandes — base LOCALE (PGlite) + logique pure + contrôles de code.
 * Aucune connexion à Supabase, aucune écriture en production, aucune nouvelle migration.
 */
import { test, expect } from '@playwright/test';
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { etatSignature } from '../src/lib/signatureBl';
import { blSigne, cleArchiveSigne, type DepotArchive, type NoteBl, type SignatureComplete } from '../src/lib/blArchive';
import { signatureTest, versDataUrl } from './helpers/png';

const lire = (f: string) => readFileSync(f, 'utf8');
const SEQ = lire('supabase/migrations/bl_sequence.sql'), SIG = lire('supabase/migrations/bl_signatures.sql'), CMD = lire('supabase/migrations/bl_commandes.sql');
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const CONTENU = (n: string) => JSON.stringify({ pdv: { name: n, items: [{ product_name: 'Cola', quantity: 5 }] }, date: '10/11/2026' });

const ENV = `
  CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN BYPASSRLS;
  ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
  CREATE SCHEMA storage; CREATE TABLE storage.buckets (id text PRIMARY KEY, name text NOT NULL, public boolean DEFAULT false, file_size_limit bigint, allowed_mime_types text[]);
  CREATE TABLE admin_audit_logs (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), admin_email text NOT NULL, action text NOT NULL, target_type text,
    target_id text, target_label text, details jsonb, created_at timestamptz NOT NULL DEFAULT now());
  CREATE TABLE client_accounts (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), nom text NOT NULL, email text);
  CREATE TABLE orders (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), nom text, email text, user_id uuid, status text, bl_number text, created_at timestamptz DEFAULT now());
  CREATE TABLE delivery_notes (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), delivery_id text NOT NULL,
    client_id uuid REFERENCES client_accounts(id) ON DELETE SET NULL, pdv_key text NOT NULL, pdv_name text NOT NULL,
    storage_path text NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
  ALTER TABLE delivery_notes ENABLE ROW LEVEL SECURITY; ALTER TABLE admin_audit_logs ENABLE ROW LEVEL SECURITY;
  GRANT USAGE ON SCHEMA public, storage TO anon, authenticated, service_role;`;

const un = async (db: PGlite, q: string, p: unknown[] = []) => (await db.query<any>(q, p)).rows[0];
const tous = async (db: PGlite, q: string, p: unknown[] = []) => (await db.query<any>(q, p)).rows;
const refus = async (db: PGlite, q: string, p: unknown[] = []) => { try { await db.query(q, p); return null; } catch (e: any) { return String(e.message); } };

test.describe.serial('Scénarios d\'annulation (base locale, schéma de production)', () => {
  let db: PGlite; let order: string, blA: string, blB: string;
  const signer = (bl: string, role: string, nom: string, par = 'gerald@inca.re') =>
    un(db, `INSERT INTO bl_signatures (delivery_note_id, role, signature_data, signataire_nom, signed_by) VALUES ($1,$2,$3,$4,$5) RETURNING id`, [bl, role, PNG, nom, par]);
  // Ce que fait la route d'annulation : seuls ces trois champs sont renseignés, uniquement si la signature est encore active.
  const annuler = (id: string, par = 'admin@inca.re', motif = 'Mauvaise personne') =>
    tous(db, `UPDATE bl_signatures SET annulee_le = now(), annulee_par = $2, annulation_motif = $3 WHERE id = $1 AND annulee_le IS NULL RETURNING id`, [id, par, motif]);
  const actives = (bl: string) => tous(db, `SELECT role, annulee_le FROM bl_signatures WHERE delivery_note_id=$1 AND annulee_le IS NULL`, [bl]);
  const etat = async (bl: string) => etatSignature(await actives(bl));

  test.beforeAll(async () => {
    db = new PGlite(); await db.exec(ENV); await db.exec(SEQ); await db.exec(`SELECT setval('bl_number_seq', 91)`);
    await db.exec(SIG); await db.exec(CMD);
    order = (await un(db, `INSERT INTO orders (nom, status) VALUES ('c', 'confirmee') RETURNING id`)).id;
    const creer = async (cle: string) => (await un(db, `SELECT * FROM bl_creer($1, NULL, 'k', 'Station', $2::jsonb, $3::jsonb)`, [cle, CONTENU('Station'), JSON.stringify([{ order_id: order, empreinte: 'h' }])])).bl_id;
    blA = await creer('livraison:a:k'); blB = await creer('livraison:b:k');   // une commande livrée en deux fois : deux BL
  });
  test.afterAll(async () => { await db.close(); });

  test('BL signé → annulation du destinataire → « Signé partiellement » ; la signature d\'origine est conservée intacte', async () => {
    const t = await signer(blA, 'transporteur', 'Gérald'); const d = await signer(blA, 'destinataire', 'Marie Client');
    expect(await etat(blA)).toBe('signe');
    const avantImage = (await un(db, `SELECT signature_data, signataire_nom, signed_by, signed_at, created_at FROM bl_signatures WHERE id=$1`, [d.id]));
    expect((await annuler(d.id)).length).toBe(1);
    expect(await etat(blA)).toBe('partiel');
    const apres = await un(db, `SELECT signature_data, signataire_nom, signed_by, signed_at, created_at, annulee_par, annulation_motif, annulee_le FROM bl_signatures WHERE id=$1`, [d.id]);
    expect({ ...apres, annulee_par: undefined, annulation_motif: undefined, annulee_le: undefined }).toEqual({ ...avantImage, annulee_par: undefined, annulation_motif: undefined, annulee_le: undefined });
    expect(apres).toMatchObject({ annulee_par: 'admin@inca.re', annulation_motif: 'Mauvaise personne' });   // l'administrateur et le motif sont enregistrés
    expect(apres.annulee_le).toBeTruthy();
    expect((await actives(blA)).map(s => s.role)).toEqual(['transporteur']);
    expect(t.id).toBeTruthy();
  });

  test('l\'annulation est journalisée (signature d\'origine, administrateur, motif) dans admin_audit_logs, par la base', async () => {
    const j = await un(db, `SELECT * FROM admin_audit_logs WHERE action='bl.signature_annulee' ORDER BY created_at DESC LIMIT 1`);
    expect(j.admin_email).toBe('admin@inca.re');
    expect(j.target_label).toMatch(/^BL-00\d+ — Station$/);
    expect(j.details).toMatchObject({ role: 'destinataire', signataire_nom: 'Marie Client', signed_by: 'gerald@inca.re', motif: 'Mauvaise personne' });
    expect(j.details.empreinte).toBeTruthy();
    expect((await un(db, `SELECT count(*)::int n FROM admin_audit_logs WHERE action='bl.signature'`)).n).toBe(2);   // les deux signatures d'origine restent tracées
  });

  test('nouvelle signature possible après annulation → « Signé » ; l\'historique garde les deux versions', async () => {
    await signer(blA, 'destinataire', 'Paul Destinataire');
    expect(await etat(blA)).toBe('signe');
    const lignes = await tous(db, `SELECT signataire_nom, annulee_le IS NOT NULL AS annulee FROM bl_signatures WHERE delivery_note_id=$1 AND role='destinataire' ORDER BY created_at, signataire_nom`, [blA]);
    expect(lignes).toHaveLength(2);
    expect(lignes.find(l => l.annulee)!.signataire_nom).toBe('Marie Client');
    expect(lignes.find(l => !l.annulee)!.signataire_nom).toBe('Paul Destinataire');
  });

  test('annulation de la signature du TRANSPORTEUR : le destinataire reste valide ; « Terminer » permet de refaire le transporteur', async () => {
    const t = (await un(db, `SELECT id FROM bl_signatures WHERE delivery_note_id=$1 AND role='transporteur' AND annulee_le IS NULL`, [blA])).id;
    await annuler(t, 'admin@inca.re', 'Mauvais nom');
    expect(await etat(blA)).toBe('partiel');
    expect((await actives(blA)).map(s => s.role)).toEqual(['destinataire']);
    await signer(blA, 'transporteur', 'Arnaud');
    expect(await etat(blA)).toBe('signe');
  });

  test('annuler les DEUX signatures : retour à « Non signé », rien n\'est supprimé', async () => {
    for (const s of await tous(db, `SELECT id FROM bl_signatures WHERE delivery_note_id=$1 AND annulee_le IS NULL`, [blA])) await annuler(s.id, 'admin@inca.re', 'Tout refaire');
    expect(await etat(blA)).toBe('non_signe');
    expect((await un(db, `SELECT count(*)::int n FROM bl_signatures WHERE delivery_note_id=$1`, [blA])).n).toBe(4);   // transporteur d'origine + transporteur refait + destinataire d'origine + destinataire refait : toutes conservées
    expect((await un(db, `SELECT count(*)::int n FROM bl_signatures WHERE delivery_note_id=$1 AND annulee_le IS NULL`, [blA])).n).toBe(0);
  });

  test('plusieurs BL pour une même commande : annuler sur l\'un ne touche JAMAIS l\'autre', async () => {
    await signer(blB, 'transporteur', 'Gérald'); await signer(blB, 'destinataire', 'Client B');
    expect(await etat(blB)).toBe('signe');
    await signer(blA, 'transporteur', 'Gérald'); await signer(blA, 'destinataire', 'Client A');
    const aAnnuler = (await un(db, `SELECT id FROM bl_signatures WHERE delivery_note_id=$1 AND role='destinataire' AND annulee_le IS NULL`, [blA])).id;
    await annuler(aAnnuler);
    expect(await etat(blA)).toBe('partiel');
    expect(await etat(blB)).toBe('signe');                                         // BL B intact
    expect((await un(db, `SELECT count(*)::int n FROM bl_signatures WHERE delivery_note_id=$1 AND annulee_le IS NOT NULL`, [blB])).n).toBe(0);
  });

  test('double annulation (deux administrateurs en même temps) : une seule a lieu, l\'autre ne modifie rien', async () => {
    const id = (await un(db, `SELECT id FROM bl_signatures WHERE delivery_note_id=$1 AND role='transporteur' AND annulee_le IS NULL`, [blA])).id;
    expect((await annuler(id, 'admin1@inca.re', 'premier')).length).toBe(1);
    expect((await annuler(id, 'admin2@inca.re', 'second')).length).toBe(0);        // la route répond « déjà annulée » (jamais de faux succès)
    expect((await un(db, `SELECT annulee_par, annulation_motif FROM bl_signatures WHERE id=$1`, [id]))).toEqual({ annulee_par: 'admin1@inca.re', annulation_motif: 'premier' });
  });

  test('la base refuse toute annulation sans motif ou sans auteur, toute suppression, toute autre modification', async () => {
    const id = (await un(db, `SELECT id FROM bl_signatures WHERE delivery_note_id=$1 AND role='destinataire' AND annulee_le IS NOT NULL LIMIT 1`, [blA])).id;
    const vivante = (await un(db, `SELECT id FROM bl_signatures WHERE delivery_note_id=$1 AND annulee_le IS NULL LIMIT 1`, [blB])).id;
    expect(await refus(db, `UPDATE bl_signatures SET annulee_le = now(), annulee_par = 'a@b.re', annulation_motif = '  ' WHERE id=$1`, [vivante])).toMatch(/check|modifiée/i);
    expect(await refus(db, `UPDATE bl_signatures SET annulee_le = now(), annulee_par = NULL, annulation_motif = 'x' WHERE id=$1`, [vivante])).toMatch(/check|modifiée/i);
    expect(await refus(db, `UPDATE bl_signatures SET signataire_nom = 'Falsifié' WHERE id=$1`, [vivante])).toMatch(/ne peut pas être modifiée/);
    expect(await refus(db, `UPDATE bl_signatures SET annulation_motif = 'autre', annulee_par = 'x@y.re' WHERE id=$1`, [id])).toMatch(/déjà annulée/);   // une annulation ne se modifie pas
    expect(await refus(db, `DELETE FROM bl_signatures WHERE id=$1`, [id])).toMatch(/ne peut pas être supprimée/);
    expect(await refus(db, `TRUNCATE bl_signatures`)).toMatch(/ne peuvent pas être vidées/);
  });

  test('le contenu figé et le numéro des BL ne changent jamais, quelles que soient les annulations', async () => {
    const n = await tous(db, `SELECT delivery_id, contenu FROM delivery_notes ORDER BY delivery_id`);
    expect(n.map(x => x.delivery_id)).toEqual(['BL-0092', 'BL-0093']);
    expect(n.every(x => x.contenu.pdv.items[0].quantity === 5 && x.contenu.date === '10/11/2026')).toBe(true);
    expect(await refus(db, `UPDATE delivery_notes SET delivery_id = 'BL-9999' WHERE id=$1`, [blA])).toMatch(/ne peut pas être modifié/);
    expect(await refus(db, `UPDATE delivery_notes SET contenu = '{}'::jsonb WHERE id=$1`, [blA])).toMatch(/figé/);
    expect(Number((await un(db, `SELECT last_value FROM bl_number_seq`)).last_value)).toBe(93);   // aucune annulation ne consomme de numéro
  });
});

// ── PDF signé : il reflète les signatures valides, l'historique reste archivé ────────────────────────────────────────
class FauxArchive implements DepotArchive {
  fichiers = new Map<string, Buffer>();
  constructor(public note: NoteBl, public toutes: (SignatureComplete & { annulee?: boolean })[]) {}
  async lireNote() { return this.note; }
  async lireSignaturesActives() { return this.toutes.filter(s => !s.annulee); }   // comme la vraie lecture : .is('annulee_le', null)
  async lireFichier(c: string) { return this.fichiers.get(c) ?? null; }
  async ecrireFichier(c: string, pdf: Buffer) { if (!this.fichiers.has(c)) this.fichiers.set(c, pdf); return null; }
  formaterDate = (iso: string) => iso;
}
test.describe('PDF du BL signé après annulation', () => {
  const img = versDataUrl(signatureTest());
  const sig = (id: string, role: string, nom: string): SignatureComplete & { annulee?: boolean } => ({ id, role, signature_data: img, signataire_nom: nom, signed_at: '2026-11-10T09:00:00Z' });
  const note: NoteBl = { delivery_id: 'BL-0092', contenu: { pdv: { name: 'Station', client_societe: 'SARL', items: [{ product_name: 'Cola', quantity: 5, units_per_carton: 24 }] }, date: '10/11/2026' } };

  test('plus de BL signé tant qu\'une signature est annulée ; une fois refaite, nouveau PDF archivé et l\'ancien est conservé', async () => {
    const t = sig('t1', 'transporteur', 'Gérald'), d1 = sig('d1', 'destinataire', 'Marie');
    const depot = new FauxArchive(note, [t, d1]);
    const v1 = (await blSigne(depot, 'x'))!;
    expect(v1.source).toBe('regenere');
    const cleV1 = cleArchiveSigne('BL-0092', ['t1', 'd1']);
    expect(depot.fichiers.has(cleV1)).toBe(true);

    d1.annulee = true;                                                      // annulation du destinataire
    expect(await blSigne(depot, 'x')).toBeNull();                           // pas de « BL signé (PDF) » avec une seule signature valide
    expect(depot.fichiers.has(cleV1)).toBe(true);                           // l'ancien PDF signé reste archivé (historique)

    const d2 = sig('d2', 'destinataire', 'Paul'); depot.toutes.push(d2);    // nouvelle signature
    const v2 = (await blSigne(depot, 'x'))!;
    const cleV2 = cleArchiveSigne('BL-0092', ['t1', 'd2']);
    expect(cleV2).not.toBe(cleV1);
    expect(depot.fichiers.get(cleV2)!.equals(v2.buffer)).toBe(true);
    expect(depot.fichiers.has(cleV1)).toBe(true);                           // les deux versions coexistent, aucune n'est écrasée
    expect(v2.source).toBe('regenere');
    expect((await blSigne(depot, 'x'))!.source).toBe('archive');            // ensuite servi depuis l'archive
  });
});

// ── Contrôles de code : droits, confirmation, aucune suppression, aucune migration ───────────────────────────────────
test.describe('Route et fiche Commandes : sécurité', () => {
  const route = lire('src/pages/api/admin/bl-signatures/[id]/annuler.ts');
  const composant = lire('src/components/admin/BlCommande.astro');
  const commandes = lire('src/pages/admin/commandes.astro');

  test('route : administrateur seulement, avant toute lecture ou écriture ; motif ET confirmation explicite exigés côté serveur', () => {
    expect(route.indexOf('isAdmin(user)')).toBeGreaterThan(0);
    expect(route.indexOf('isAdmin(user)')).toBeLessThan(route.indexOf("from('bl_signatures')"));
    expect(route).toMatch(/Seul un administrateur peut annuler une signature/);
    expect(route).toMatch(/motif\.length < 3/);
    expect(route).toMatch(/form\.get\('confirme'\) !== 'oui'/);
    expect(route.indexOf("form.get('confirme')")).toBeLessThan(route.indexOf('.update('));
  });
  test('route : n\'écrit QUE les trois champs d\'annulation, ne supprime jamais, ne touche ni BL, ni commande, ni e-mail', () => {
    const maj = route.slice(route.indexOf('.update('), route.indexOf('.update(') + 140);
    expect(maj).toMatch(/annulee_le.*annulee_par: user\.email.*annulation_motif: motif/s);
    expect(route).not.toMatch(/\.delete\(|\.upsert\(|\.insert\(|\.rpc\(|from\('delivery_notes'\)|from\('orders'\)/);
    expect(route).not.toMatch(/resend|sendOrderStatusEmail|lib\/email|logAdminAction/);   // trace écrite par la base (trigger)
    expect(route).toMatch(/\.is\('annulee_le', null\)/);                                    // jamais sur une signature déjà annulée
    expect(route).toMatch(/modifiees\.length === 0/);                                       // jamais de faux succès
  });
  test('route : retour vers la fiche de la commande (identifiant validé), plus vers Livraison', () => {
    expect(route).toMatch(/estUuid\(brut\)/);
    expect(route).toMatch(/\/admin\/commandes\?/);
    expect(route).not.toMatch(/\/admin\/livraison|sig_ok|sig_err/);
  });
  test('fiche : le bouton n\'existe que pour l\'administrateur ET s\'il y a une signature active ; une confirmation par signature choisie', () => {
    expect(composant).toMatch(/peutAnnuler && bl\.signatures\.length > 0/);
    expect(commandes).toMatch(/peutAnnuler=\{viewerIsAdmin\}/);
    expect(commandes).toMatch(/const viewerIsAdmin = isAdmin\(/);
    for (const t of ['Annuler une signature', 'Motif de l\'annulation (obligatoire)', 'Je confirme l\'annulation', 'Ne pas annuler', 'n\'est pas supprimée', 'Annuler la signature du {LIBELLE_ROLE[r].toLowerCase()}'])
      expect(composant, t).toContain(t);
    expect(composant).toMatch(/name="motif" required minlength="3"/);
    expect(composant).toMatch(/name="confirme" value="oui" required/);
    expect(composant).toMatch(/formaction=\{`\/api\/admin\/bl-signatures\/\$\{parRole\[r\]\.id\}\/annuler`\}/);   // chaque bouton désigne SA signature
    expect(composant).toMatch(/const ACTION_NEUTRE = '\/api\/admin\/bl-signatures\/00000000-0000-0000-0000-000000000000\/annuler'/);   // pas d'envoi involontaire
  });
  test("l'annulation n'exige aucune modification des migrations du système de BL", () => {
    // Les migrations du BL (signatures, commandes, numérotation) ne doivent pas avoir bougé par rapport à main.
    expect(execSync('git diff --name-only main -- supabase/migrations/bl_signatures.sql supabase/migrations/bl_commandes.sql supabase/migrations/bl_sequence.sql', { encoding: 'utf8' }).trim()).toBe('');
  });
});
