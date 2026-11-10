/**
 * Sécurisation de next_bl_number() et de la séquence bl_number_seq (bl_commandes.sql, section 7) — base LOCALE (PGlite).
 * Reproduit l'état relevé en production : fonction et séquence ouvertes à anon / authenticated, séquence à 91,
 * BL-0091 avec ses deux signatures annulées et son historique. Aucune connexion à Supabase.
 */
import { test, expect } from '@playwright/test';
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';

const SEQ = readFileSync('supabase/migrations/bl_sequence.sql', 'utf8');
const SIG = readFileSync('supabase/migrations/bl_signatures.sql', 'utf8');
const SQL = readFileSync('supabase/migrations/bl_commandes.sql', 'utf8');
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

const ENV = `
  CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN BYPASSRLS; CREATE ROLE autre NOLOGIN;
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
  GRANT USAGE ON SCHEMA public, storage TO anon, authenticated, service_role, autre;`;

const un = async (db: PGlite, q: string, p: unknown[] = []) => (await db.query<any>(q, p)).rows[0];
const tous = async (db: PGlite, q: string, p: unknown[] = []) => (await db.query<any>(q, p)).rows;
const refus = async (db: PGlite, q: string, p: unknown[] = []) => { try { await db.query(q, p); return null; } catch (e: any) { return String(e.message); } };
const seq = async (db: PGlite) => Number((await un(db, `SELECT last_value FROM bl_number_seq`)).last_value);
const CONTENU = JSON.stringify({ pdv: { name: 'P', items: [{ product_name: 'Cola', quantity: 3 }] }, date: '10/11/2026' });
/** Exécute une requête sous un rôle, puis revient au propriétaire. */
const sous = async (db: PGlite, role: string, q: string, p: unknown[] = []) => {
  await db.exec(`SET ROLE ${role}`);
  try { return { ok: true as const, ligne: (await db.query<any>(q, p)).rows[0] }; }
  catch (e: any) { return { ok: false as const, erreur: String(e.message) }; }
  finally { await db.exec(`RESET ROLE`); }
};

test.describe.serial('Constat AVANT : numérotation ouverte (état de la production)', () => {
  let db: PGlite;
  test.beforeAll(async () => {
    db = new PGlite(); await db.exec(ENV); await db.exec(SEQ);
    await db.exec(`GRANT ALL ON SEQUENCE bl_number_seq TO anon, authenticated, service_role`);   // droits relevés en production (rwU)
    await db.exec(`SELECT setval('bl_number_seq', 91)`);
  });
  test.afterAll(async () => { await db.close(); });

  test('anon et authenticated PEUVENT aujourd\'hui consommer un numéro, via la fonction ou directement sur la séquence', async () => {
    expect((await sous(db, 'anon', `SELECT next_bl_number() AS n`)).ok).toBe(true);
    expect((await sous(db, 'authenticated', `SELECT next_bl_number() AS n`)).ok).toBe(true);
    expect((await sous(db, 'anon', `SELECT nextval('bl_number_seq') AS n`)).ok).toBe(true);
    expect(await seq(db)).toBe(94);   // 3 numéros brûlés par des rôles non autorisés
  });
});

test.describe.serial('Après bl_commandes.sql : numérotation réservée au serveur, données préservées', () => {
  let db: PGlite; let note: string; let avant: string;
  const instantane = async () => JSON.stringify({
    orders: await tous(db, `SELECT * FROM orders ORDER BY id`),
    clients: await tous(db, `SELECT * FROM client_accounts ORDER BY id`),
    notes: await tous(db, `SELECT id, delivery_id, client_id, pdv_key, pdv_name, storage_path, created_at, contenu FROM delivery_notes ORDER BY delivery_id`),
    signatures: await tous(db, `SELECT * FROM bl_signatures ORDER BY id`),                       // toutes les colonnes, annulations comprises
    audit: await tous(db, `SELECT * FROM admin_audit_logs ORDER BY id`),
    sequence: await un(db, `SELECT last_value, is_called FROM bl_number_seq`),
  });

  test.beforeAll(async () => {
    db = new PGlite(); await db.exec(ENV); await db.exec(SEQ);
    await db.exec(`GRANT ALL ON SEQUENCE bl_number_seq TO anon, authenticated, service_role`);
    await db.exec(`SELECT setval('bl_number_seq', 90)`);
    await db.exec(SIG);
    // 77 anciens BL sur papier + commandes annulées
    await db.exec(`INSERT INTO orders (nom, status, bl_number) SELECT 'c' || g, 'livree', 'BL-' || lpad((g + 11)::text, 4, '0') FROM generate_series(1, 77) g;
                   INSERT INTO orders (nom, status) VALUES ('a1', 'annulee'), ('a2', 'annulee')`);
    const client = (await un(db, `INSERT INTO client_accounts (nom) VALUES ('TEST') RETURNING id`)).id;
    // BL-0091 : généré, signé par les deux parties, puis les deux signatures annulées (état réel de la production)
    note = (await un(db, `INSERT INTO delivery_notes (delivery_id, client_id, pdv_key, pdv_name, storage_path, contenu) VALUES ('BL-0091', $1, 'client_x', 'TEST', 'BL-0091/client_x.pdf', $2::jsonb) RETURNING id`, [client, CONTENU])).id;
    for (const role of ['transporteur', 'destinataire']) {
      await db.query(`INSERT INTO bl_signatures (delivery_note_id, role, signature_data, signataire_nom, signed_by) VALUES ($1,$2,$3,'Testeur','nicolas@inca.re')`, [note, role, PNG]);
      await db.query(`UPDATE bl_signatures SET annulee_le = now(), annulee_par = 'admin@inca.re', annulation_motif = 'essai' WHERE delivery_note_id=$1 AND role=$2`, [note, role]);
    }
    await db.exec(`SELECT setval('bl_number_seq', 91)`);
    avant = await instantane();
    await db.exec(SQL);
  });
  test.afterAll(async () => { await db.close(); });

  test('BL-0091, ses signatures annulées, son historique, les 77 anciens BL et la séquence : strictement intacts', async () => {
    expect(await instantane()).toBe(avant);
    expect((await un(db, `SELECT count(*)::int n FROM bl_signatures WHERE annulee_le IS NOT NULL`)).n).toBe(2);
    expect((await un(db, `SELECT count(*)::int n FROM admin_audit_logs WHERE action LIKE 'bl.%'`)).n).toBe(4);
    expect((await un(db, `SELECT count(*)::int n, count(DISTINCT bl_number)::int d, min(bl_number) mn, max(bl_number) mx FROM orders WHERE bl_number IS NOT NULL`)))
      .toEqual({ n: 77, d: 77, mn: 'BL-0012', mx: 'BL-0088' });
  });

  test('anon, authenticated et tout autre rôle : impossible d\'appeler next_bl_number ou de toucher la séquence ; aucun numéro consommé', async () => {
    const s = await seq(db);
    for (const role of ['anon', 'authenticated', 'autre']) {
      expect((await sous(db, role, `SELECT next_bl_number() AS n`)).ok, `${role} next_bl_number`).toBe(false);
      const r = await sous(db, role, `SELECT next_bl_number() AS n`);
      if (!r.ok) expect(r.erreur).toMatch(/permission denied for function next_bl_number/);
      expect((await sous(db, role, `SELECT nextval('bl_number_seq') AS n`)).ok, `${role} nextval`).toBe(false);
      expect((await sous(db, role, `SELECT last_value FROM bl_number_seq`)).ok, `${role} lecture`).toBe(false);
      expect((await sous(db, role, `SELECT setval('bl_number_seq', 1)`)).ok, `${role} setval`).toBe(false);
      expect((await sous(db, role, `SELECT * FROM bl_creer('x-${role}', NULL, 'k', 'P', $1::jsonb, '[]'::jsonb)`, [CONTENU])).ok, `${role} bl_creer`).toBe(false);
    }
    expect(await seq(db)).toBe(s);
    expect((await un(db, `SELECT count(*)::int n FROM delivery_notes`)).n).toBe(1);
  });

  test('la génération légitime (serveur) fonctionne : numéro suivant, jamais un numéro déjà utilisé', async () => {
    const r = await sous(db, 'service_role', `SELECT * FROM bl_creer('commande:o1:initial', NULL, 'commande_o1', 'Station', $1::jsonb, '[]'::jsonb)`, [CONTENU]);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.ligne).toMatchObject({ bl_numero: 'BL-0092', bl_cree: true });
    expect(await seq(db)).toBe(92);
    const direct = await sous(db, 'service_role', `SELECT next_bl_number() AS n`);
    expect(direct.ok && direct.ligne.n).toBe('BL-0093');
    const tousNumeros = (await tous(db, `SELECT delivery_id FROM delivery_notes`)).map(x => x.delivery_id);
    expect(new Set(tousNumeros).size).toBe(tousNumeros.length);   // aucun doublon
    expect(tousNumeros).not.toContain('BL-0093');                 // 93 a été consommé par l'appel direct du serveur : jamais réattribué
  });

  test('doubles clics : même clé = même BL, aucun nouveau numéro ; la numérotation ne revient jamais en arrière', async () => {
    const s = await seq(db);
    const a = await sous(db, 'service_role', `SELECT * FROM bl_creer('commande:o1:initial', NULL, 'commande_o1', 'Station', $1::jsonb, '[]'::jsonb)`, [CONTENU]);
    const b = await sous(db, 'service_role', `SELECT * FROM bl_creer('commande:o1:initial', NULL, 'commande_o1', 'Station', $1::jsonb, '[]'::jsonb)`, [CONTENU]);
    expect(a.ok && b.ok).toBe(true);
    if (a.ok && b.ok) { expect(a.ligne.bl_numero).toBe('BL-0092'); expect(b.ligne.bl_cree).toBe(false); expect(a.ligne.bl_id).toBe(b.ligne.bl_id); }
    expect(await seq(db)).toBe(s);
    const suivant = await sous(db, 'service_role', `SELECT * FROM bl_creer('commande:o2:initial', NULL, 'commande_o2', 'Station', $1::jsonb, '[]'::jsonb)`, [CONTENU]);
    if (suivant.ok) expect(suivant.ligne.bl_numero).toBe('BL-0094');
  });

  test('fonction durcie : search_path fixé, droits exacts, séquence fermée ; migration rejouable sans changer ces droits ni la séquence', async () => {
    const etat = async () => ({
      cfg: (await un(db, `SELECT proconfig FROM pg_proc WHERE proname='next_bl_number'`)).proconfig,
      fonction: (await tous(db, `SELECT r.rolname FROM pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a JOIN pg_roles r ON r.oid = a.grantee WHERE p.proname='next_bl_number' AND a.privilege_type='EXECUTE' ORDER BY 1`)).map(x => x.rolname),
      public: (await un(db, `SELECT count(*)::int n FROM pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a WHERE p.proname='next_bl_number' AND a.grantee = 0`)).n,
      sequence: (await tous(db, `SELECT r.rolname FROM pg_class c, aclexplode(c.relacl) a JOIN pg_roles r ON r.oid = a.grantee WHERE c.relname='bl_number_seq' ORDER BY 1`)).map(x => x.rolname),
      valeur: await seq(db),
    });
    const e1 = await etat();
    expect(e1.cfg).toEqual(['search_path=public, pg_temp']);
    expect(e1.fonction).toEqual(['postgres', 'service_role']);   // le propriétaire (postgres) et le serveur, personne d'autre
    expect(e1.public).toBe(0);
    expect(e1.sequence).not.toContain('anon'); expect(e1.sequence).not.toContain('authenticated');
    await db.exec(SQL);
    expect(await etat()).toEqual(e1);
  });

  test('BL-0091 reste figé et ses preuves intactes après usage', async () => {
    expect(await refus(db, `UPDATE delivery_notes SET delivery_id = 'BL-9999' WHERE id=$1`, [note])).toMatch(/ne peut pas être modifié/);
    expect(await refus(db, `DELETE FROM delivery_notes WHERE id=$1`, [note])).toMatch(/ne peut pas être supprimée/);
    expect(await refus(db, `DELETE FROM bl_signatures`)).toMatch(/ne peut pas être supprimée/);
    expect((await un(db, `SELECT count(*)::int n FROM bl_signatures WHERE delivery_note_id=$1 AND annulee_le IS NOT NULL`, [note])).n).toBe(2);
  });

  test('statique : section 7 présente, additive ; le code de l\'application n\'appelle plus next_bl_number', () => {
    const code = SQL.split(/\r?\n/).filter(l => !l.trim().startsWith('--')).join('\n');
    expect(code).toMatch(/REVOKE ALL ON FUNCTION next_bl_number\(\) FROM PUBLIC, anon, authenticated;/);
    expect(code).toMatch(/GRANT EXECUTE ON FUNCTION next_bl_number\(\) TO service_role;/);
    expect(code).toMatch(/ALTER FUNCTION next_bl_number\(\) SET search_path = public, pg_temp;/);
    expect(code).toMatch(/REVOKE ALL ON SEQUENCE bl_number_seq FROM PUBLIC, anon, authenticated;/);
    expect(code).not.toMatch(/setval|ALTER SEQUENCE|RESTART|DROP\s+(TABLE|COLUMN|FUNCTION\s+next_bl_number)|DELETE\s+FROM|UPDATE\s+\w+\s+SET|TRUNCATE\s+\w+\s*;/i);
    expect(execSync('git grep -c "next_bl_number" -- src || true', { encoding: 'utf8' }).trim()).toBe('');
  });
});
