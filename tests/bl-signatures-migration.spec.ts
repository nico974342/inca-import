/**
 * Migration bl_signatures.sql sur une base LOCALE (PGlite) : aucune connexion à Supabase, aucune écriture en production.
 * Vérifie le schéma, les contraintes, l'immuabilité de la preuve et les accès par rôle.
 */
import { test, expect } from '@playwright/test';
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';

const SQL = readFileSync('supabase/migrations/bl_signatures.sql', 'utf8');
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

// Environnement minimal qui ressemble à Supabase : rôles, schéma storage, table delivery_notes existante.
const ENV = `
  CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN BYPASSRLS;
  ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;   -- comme Supabase : droits par défaut sur toute nouvelle table
  CREATE SCHEMA storage; CREATE TABLE storage.buckets (id text PRIMARY KEY, name text NOT NULL, public boolean DEFAULT false, file_size_limit bigint, allowed_mime_types text[]);
  CREATE TABLE admin_audit_logs (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), admin_email text NOT NULL, action text NOT NULL, target_type text,
    target_id text, target_label text, details jsonb, created_at timestamptz NOT NULL DEFAULT now());
  CREATE TABLE delivery_notes (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), delivery_id text NOT NULL, client_id uuid,
    pdv_key text NOT NULL, pdv_name text NOT NULL, storage_path text NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
  ALTER TABLE delivery_notes ENABLE ROW LEVEL SECURITY;
  GRANT ALL ON ALL TABLES IN SCHEMA public TO service_role; GRANT USAGE ON SCHEMA public, storage TO anon, authenticated, service_role;
  INSERT INTO delivery_notes (delivery_id, pdv_key, pdv_name, storage_path) VALUES ('BL-0001', 'k1', 'Station A', 'BL-0001/k1.pdf'), ('BL-0002', 'k2', 'Station B', 'BL-0002/k2.pdf');`;

const un = async (db: PGlite, q: string, p: unknown[] = []) => (await db.query<any>(q, p)).rows[0];
const refus = async (db: PGlite, q: string, p: unknown[] = []) => {
  try { await db.query(q, p); return null; } catch (e: any) { return String(e.message); }
};

test.describe.serial('Migration bl_signatures.sql (base locale)', () => {
  let db: PGlite; let bl1: string; let bl2: string; let avant: string;
  const notes = async () => JSON.stringify((await db.query(`SELECT id, delivery_id, client_id, pdv_key, pdv_name, storage_path, created_at FROM delivery_notes ORDER BY delivery_id`)).rows);
  const signer = (bl: string, role = 'transporteur', nom = 'Gérald', par = 'gerald@inca.re') =>
    db.query(`INSERT INTO bl_signatures (delivery_note_id, role, signature_data, signataire_nom, signed_by) VALUES ($1,$2,$3,$4,$5)`, [bl, role, PNG, nom, par]);

  test.beforeAll(async () => {
    db = new PGlite(); await db.exec(ENV);
    avant = await notes();
    bl1 = (await un(db, `SELECT id FROM delivery_notes WHERE delivery_id='BL-0001'`)).id;
    bl2 = (await un(db, `SELECT id FROM delivery_notes WHERE delivery_id='BL-0002'`)).id;
    await db.exec(SQL);
  });
  test.afterAll(async () => { await db.close(); });

  test('les BL existants sont conservés tels quels ; seule la colonne « contenu » (vide) est ajoutée ; bucket privé créé', async () => {
    expect(await notes()).toBe(avant);
    expect((await un(db, `SELECT count(*)::int n, count(contenu)::int remplis FROM delivery_notes`))).toEqual({ n: 2, remplis: 0 });
    expect(await un(db, `SELECT id, public FROM storage.buckets WHERE id='delivery-notes'`)).toEqual({ id: 'delivery-notes', public: false });
    expect((await un(db, `SELECT count(*)::int n FROM bl_signatures`)).n).toBe(0);
  });

  test('migration rejouable sans effet', async () => {
    await db.exec(SQL);
    expect(await notes()).toBe(avant);
    expect((await un(db, `SELECT count(*)::int n FROM storage.buckets`)).n).toBe(1);
  });

  test('une signature par rôle et par BL ; deux rôles différents sur le même BL ; même rôle sur un autre BL', async () => {
    await signer(bl1, 'transporteur'); await signer(bl1, 'destinataire', 'Marie Client'); await signer(bl2, 'transporteur');
    expect(await refus(db, `INSERT INTO bl_signatures (delivery_note_id, role, signature_data, signataire_nom, signed_by) VALUES ($1,'transporteur',$2,'Autre','x@y.re')`, [bl1, PNG])).toMatch(/duplicate|unique/i);
  });

  test('contraintes : rôle inconnu, image qui n\'est pas un PNG, nom vide, signataire vide, trop volumineuse', async () => {
    expect(await refus(db, `INSERT INTO bl_signatures (delivery_note_id, role, signature_data, signataire_nom, signed_by) VALUES ($1,'chauffeur',$2,'N','a@b.re')`, [bl2, PNG])).toMatch(/check/i);
    expect(await refus(db, `INSERT INTO bl_signatures (delivery_note_id, role, signature_data, signataire_nom, signed_by) VALUES ($1,'destinataire','data:text/html;base64,AAAA','N','a@b.re')`, [bl2])).toMatch(/check/i);
    expect(await refus(db, `INSERT INTO bl_signatures (delivery_note_id, role, signature_data, signataire_nom, signed_by) VALUES ($1,'destinataire',$2,'   ','a@b.re')`, [bl2, PNG])).toMatch(/check/i);
    expect(await refus(db, `INSERT INTO bl_signatures (delivery_note_id, role, signature_data, signataire_nom, signed_by) VALUES ($1,'destinataire',$2,'N','')`, [bl2, PNG])).toMatch(/check/i);
    expect(await refus(db, `INSERT INTO bl_signatures (delivery_note_id, role, signature_data, signataire_nom, signed_by) VALUES ($1,'destinataire',$2,'N','a@b.re')`, [bl2, 'data:image/png;base64,' + 'A'.repeat(400000)])).toMatch(/check/i);
    expect(await refus(db, `INSERT INTO bl_signatures (delivery_note_id, role, signature_data, signataire_nom, signed_by) VALUES ('00000000-0000-0000-0000-000000000000','destinataire',$1,'N','a@b.re')`, [PNG])).toMatch(/foreign key/i);
  });

  test('la date de signature est posée par la base (jamais par le navigateur)', async () => {
    const r = await un(db, `SELECT signed_at, created_at FROM bl_signatures WHERE delivery_note_id=$1 AND role='transporteur'`, [bl1]);
    expect(Math.abs(Date.now() - new Date(r.signed_at).getTime())).toBeLessThan(60_000);
  });

  test('preuve non modifiable : aucun champ de la signature ne peut changer', async () => {
    for (const set of [`signature_data = '${PNG}x'`, `signataire_nom = 'Autre'`, `signed_by = 'autre@inca.re'`, `signed_at = now() + interval '1 day'`, `role = 'destinataire'`]) {
      expect(await refus(db, `UPDATE bl_signatures SET ${set} WHERE delivery_note_id=$1 AND role='transporteur'`, [bl2])).toMatch(/ne peut pas être modifiée/);
    }
    expect(await refus(db, `UPDATE bl_signatures SET annulee_le = now() WHERE delivery_note_id=$1`, [bl2])).toMatch(/check|ne peut pas/i);   // sans auteur ni motif
  });

  test('suppression impossible : ligne, BL parent (cascade), vidage de la table', async () => {
    expect(await refus(db, `DELETE FROM bl_signatures WHERE delivery_note_id=$1`, [bl2])).toMatch(/ne peut pas être supprimée/);
    expect(await refus(db, `DELETE FROM delivery_notes WHERE id=$1`, [bl2])).toMatch(/ne peut pas être supprimée/);
    expect(await refus(db, `TRUNCATE bl_signatures`)).toMatch(/ne peuvent pas être vidées/);
    expect((await un(db, `SELECT count(*)::int n FROM delivery_notes`)).n).toBe(2);
    expect((await un(db, `SELECT count(*)::int n FROM bl_signatures`)).n).toBe(3);
  });

  test('un BL sans signature reste supprimable (comportement actuel inchangé)', async () => {
    const { id } = await un(db, `INSERT INTO delivery_notes (delivery_id, pdv_key, pdv_name, storage_path) VALUES ('BL-0003','k3','C','p') RETURNING id`);
    await db.query(`DELETE FROM delivery_notes WHERE id=$1`, [id]);
    expect((await un(db, `SELECT count(*)::int n FROM delivery_notes`)).n).toBe(2);
  });

  test('annulation explicite : motif et auteur obligatoires, signature d\'origine conservée, une seule fois', async () => {
    await db.query(`UPDATE bl_signatures SET annulee_le = now(), annulee_par = 'admin@inca.re', annulation_motif = 'Mauvais client' WHERE delivery_note_id=$1 AND role='transporteur'`, [bl2]);
    const r = await un(db, `SELECT signature_data, signataire_nom, annulee_par, annulation_motif FROM bl_signatures WHERE delivery_note_id=$1`, [bl2]);
    expect(r).toEqual({ signature_data: PNG, signataire_nom: 'Gérald', annulee_par: 'admin@inca.re', annulation_motif: 'Mauvais client' });
    expect(await refus(db, `UPDATE bl_signatures SET annulation_motif = 'autre' WHERE delivery_note_id=$1`, [bl2])).toMatch(/déjà annulée/);
    expect(await refus(db, `UPDATE bl_signatures SET annulee_le = now(), annulee_par = 'a@b.re', annulation_motif = '  ' WHERE delivery_note_id=$1 AND role='destinataire'`, [bl1])).toMatch(/check|ne peut pas être modifiée/i);
  });

  test('l\'annulation ne peut pas servir à modifier la signature en même temps', async () => {
    expect(await refus(db, `UPDATE bl_signatures SET annulee_le = now(), annulee_par = 'a@b.re', annulation_motif = 'x', signataire_nom = 'Falsifié' WHERE delivery_note_id=$1 AND role='destinataire'`, [bl1])).toMatch(/que les champs d'annulation/);
  });

  test('après annulation on peut re-signer ce rôle ; l\'ancienne signature reste en base comme trace', async () => {
    await signer(bl2, 'transporteur', 'Arnaud', 'arnaud@inca.re');
    const lignes = (await db.query<any>(`SELECT signataire_nom, annulee_le IS NOT NULL AS annulee FROM bl_signatures WHERE delivery_note_id=$1 ORDER BY created_at, signataire_nom`, [bl2])).rows;
    expect(lignes).toHaveLength(2);
    expect(lignes.filter(l => !l.annulee).map(l => l.signataire_nom)).toEqual(['Arnaud']);
  });

  test('accès : ni anon ni authenticated (compte client) ne voient ni n\'écrivent ; le service_role (serveur) oui', async () => {
    for (const role of ['anon', 'authenticated']) {
      await db.exec(`SET ROLE ${role}`);
      expect(await refus(db, `SELECT * FROM bl_signatures`)).toMatch(/permission denied/);
      expect(await refus(db, `INSERT INTO bl_signatures (delivery_note_id, role, signature_data, signataire_nom, signed_by) VALUES ('${bl1}','destinataire','${PNG}','x','y')`)).toMatch(/permission denied/);
      expect(await refus(db, `UPDATE bl_signatures SET annulee_le = now()`)).toMatch(/permission denied/);
      expect(await refus(db, `DELETE FROM bl_signatures`)).toMatch(/permission denied/);
      await db.exec(`RESET ROLE`);
    }
    await db.exec(`SET ROLE service_role`);
    expect((await un(db, `SELECT count(*)::int n FROM bl_signatures`)).n).toBe(4);
    expect(await refus(db, `DELETE FROM bl_signatures`)).toMatch(/permission denied/);   // le serveur n'a même pas le droit DELETE
    await db.exec(`RESET ROLE`);
  });

  test('statique : migration additive (aucun DROP de données, aucun UPDATE/DELETE de données existantes)', () => {
    const code = SQL.split('\n').filter(l => !l.trim().startsWith('--')).join('\n');
    expect(code).not.toMatch(/\bDROP\s+(TABLE|COLUMN)\b/i);
    expect(code).not.toMatch(/\bDELETE\s+FROM\b|\bUPDATE\s+\w+\s+SET\b|\bTRUNCATE\s+\w+;/i);
    expect(code).toMatch(/INSERT INTO storage\.buckets[\s\S]*ON CONFLICT \(id\) DO NOTHING/);
    expect(code).toMatch(/SET search_path = public, pg_temp/);
  });
});
