/**
 * Migration bl_commandes.sql sur une base LOCALE (PGlite) — aucune connexion à Supabase, aucune écriture en production.
 * Schéma reproduisant la production (relevé en lecture seule), bl_signatures.sql appliquée avant.
 */
import { test, expect } from '@playwright/test';
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';

const SIG = readFileSync('supabase/migrations/bl_signatures.sql', 'utf8');
const SQL = readFileSync('supabase/migrations/bl_commandes.sql', 'utf8');
const SEQ = readFileSync('supabase/migrations/bl_sequence.sql', 'utf8');
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

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
const seq = async (db: PGlite) => Number((await un(db, `SELECT last_value FROM bl_number_seq`)).last_value);

const CONTENU = (nom: string) => JSON.stringify({ pdv: { name: nom, items: [{ product_name: 'Cola', quantity: 5 }] }, date: '10/11/2026' });
const creer = (db: PGlite, cle: string, commandes: { order_id: string; empreinte: string }[], pdvKey = 'k1', nom = 'Station A') =>
  un(db, `SELECT * FROM bl_creer($1, NULL, $2, $3, $4::jsonb, $5::jsonb)`, [cle, pdvKey, nom, CONTENU(nom), JSON.stringify(commandes)]);

test.describe.serial('Migration bl_commandes.sql (base locale)', () => {
  let db: PGlite; let o1: string, o2: string, o3: string, oAnnulee: string, oLegacy: string; let avant: string;
  const instantane = async () => JSON.stringify({
    orders: await tous(db, `SELECT id, nom, status, bl_number, created_at FROM orders ORDER BY id`),
    notes: await tous(db, `SELECT id, delivery_id, client_id, pdv_key, pdv_name, storage_path, created_at FROM delivery_notes ORDER BY delivery_id`),
    sequence: await un(db, `SELECT last_value, is_called FROM bl_number_seq`),
    signatures: await tous(db, `SELECT id, role, signataire_nom FROM bl_signatures ORDER BY id`),
  });

  test.beforeAll(async () => {
    db = new PGlite(); await db.exec(ENV); await db.exec(SEQ); await db.exec(`SELECT setval('bl_number_seq', 90)`);
    await db.exec(SIG);
    const ordre = async (statut: string, bl: string | null = null) => (await un(db, `INSERT INTO orders (nom, status, bl_number) VALUES ('c', $1, $2) RETURNING id`, [statut, bl])).id;
    o1 = await ordre('confirmee'); o2 = await ordre('confirmee'); o3 = await ordre('en_preparation');
    oAnnulee = await ordre('annulee'); oLegacy = await ordre('livree', 'BL-0050');
    avant = await instantane();
    await db.exec(SQL);
  });
  test.afterAll(async () => { await db.close(); });

  test('données existantes strictement intactes (commandes, numéros de BL, BL, séquence) ; migration rejouable', async () => {
    expect(await instantane()).toBe(avant);
    await db.exec(SQL);
    expect(await instantane()).toBe(avant);
    expect((await un(db, `SELECT bl_number FROM orders WHERE id=$1`, [oLegacy])).bl_number).toBe('BL-0050');   // ancien BL : aucune liaison, aucun changement
    expect((await un(db, `SELECT count(*)::int n FROM delivery_note_orders`)).n).toBe(0);
  });

  test('BL d\'une commande : numéro suivant, chemin, contenu figé, liaison avec l\'empreinte', async () => {
    const r = await creer(db, `commande:${o1}:initial`, [{ order_id: o1, empreinte: 'h1' }]);
    expect(r.bl_cree).toBe(true); expect(r.bl_numero).toBe('BL-0091'); expect(r.bl_chemin).toBe('BL-0091/k1.pdf');
    expect(await seq(db)).toBe(91);
    const n = await un(db, `SELECT cle_operation, contenu->'pdv'->>'name' AS pdv, client_id FROM delivery_notes WHERE id=$1`, [r.bl_id]);
    expect(n).toEqual({ cle_operation: `commande:${o1}:initial`, pdv: 'Station A', client_id: null });
    expect(await tous(db, `SELECT order_id, empreinte_commande FROM delivery_note_orders WHERE delivery_note_id=$1`, [r.bl_id])).toEqual([{ order_id: o1, empreinte_commande: 'h1' }]);
  });

  test('double clic / rafraîchissement / renvoi : même BL, aucun nouveau numéro, aucun doublon', async () => {
    const a = await creer(db, `commande:${o1}:initial`, [{ order_id: o1, empreinte: 'h1' }]);
    const b = await creer(db, `commande:${o1}:initial`, [{ order_id: o1, empreinte: 'AUTRE' }], 'k9', 'Autre PDV');
    expect(a.bl_cree).toBe(false); expect(b.bl_cree).toBe(false);
    expect(a.bl_id).toBe(b.bl_id); expect(a.bl_numero).toBe('BL-0091');
    expect(await seq(db)).toBe(91);                                                        // séquence inchangée
    expect((await un(db, `SELECT count(*)::int n FROM delivery_notes WHERE cle_operation=$1`, [`commande:${o1}:initial`])).n).toBe(1);
    expect((await un(db, `SELECT count(*)::int n FROM delivery_note_orders WHERE order_id=$1`, [o1])).n).toBe(1);   // la 2e demande n'ajoute aucune liaison
  });

  test('livraison regroupée : un BL pour plusieurs commandes du même point de vente', async () => {
    const r = await creer(db, 'livraison:nonce-1:client_x', [{ order_id: o2, empreinte: 'h2' }, { order_id: o3, empreinte: 'h3' }], 'client_x', 'Station B');
    expect(r.bl_cree).toBe(true); expect(r.bl_numero).toBe('BL-0092');
    expect((await tous(db, `SELECT order_id FROM delivery_note_orders WHERE delivery_note_id=$1 ORDER BY order_id`, [r.bl_id])).map(x => x.order_id).sort()).toEqual([o2, o3].sort());
  });

  test('livraison en plusieurs fois : plusieurs BL pour la même commande, chacun avec son numéro', async () => {
    const a = await creer(db, 'livraison:nonce-2:client_x', [{ order_id: o2, empreinte: 'h2' }], 'client_x', 'Station B');
    const b = await creer(db, 'livraison:nonce-3:client_x', [{ order_id: o2, empreinte: 'h2' }], 'client_x', 'Station B');
    expect([a.bl_numero, b.bl_numero]).toEqual(['BL-0093', 'BL-0094']);
    expect((await un(db, `SELECT count(*)::int n FROM delivery_note_orders WHERE order_id=$1`, [o2])).n).toBe(3);   // regroupé + 2 partiels
  });

  test('commande annulée ou inconnue : refus net, aucun numéro consommé, rien d\'écrit', async () => {
    const s = await seq(db); const notes = (await un(db, `SELECT count(*)::int n FROM delivery_notes`)).n;
    expect(await refus(db, `SELECT * FROM bl_creer('x1', NULL, 'k', 'P', $1::jsonb, $2::jsonb)`, [CONTENU('P'), JSON.stringify([{ order_id: oAnnulee, empreinte: 'h' }])])).toMatch(/annulée/);
    expect(await refus(db, `SELECT * FROM bl_creer('x2', NULL, 'k', 'P', $1::jsonb, $2::jsonb)`, [CONTENU('P'), JSON.stringify([{ order_id: '00000000-0000-0000-0000-000000000000', empreinte: 'h' }])])).toMatch(/introuvable/);
    expect(await refus(db, `SELECT * FROM bl_creer('', NULL, 'k', 'P', $1::jsonb, '[]'::jsonb)`, [CONTENU('P')])).toMatch(/Clé/);
    expect(await refus(db, `SELECT * FROM bl_creer('x3', NULL, 'k', 'P', NULL, '[]'::jsonb)`)).toMatch(/Contenu/);
    expect(await seq(db)).toBe(s);
    expect((await un(db, `SELECT count(*)::int n FROM delivery_notes`)).n).toBe(notes);
  });

  test('BL libre (sans commande) : créé, non rattaché ; une commande valide mêlée à une annulée : tout est refusé', async () => {
    const libre = await creer(db, 'livraison:nonce-4:client_y', [], 'client_y', 'Station C');
    expect(libre.bl_cree).toBe(true);
    expect((await un(db, `SELECT count(*)::int n FROM delivery_note_orders WHERE delivery_note_id=$1`, [libre.bl_id])).n).toBe(0);
    const s = await seq(db);
    expect(await refus(db, `SELECT * FROM bl_creer('x4', NULL, 'k', 'P', $1::jsonb, $2::jsonb)`, [CONTENU('P'), JSON.stringify([{ order_id: o1, empreinte: 'h' }, { order_id: oAnnulee, empreinte: 'h' }])])).toMatch(/annulée/);
    expect(await seq(db)).toBe(s);
  });

  test('liaison non modifiable ; suppression directe, TRUNCATE et TRUNCATE ... CASCADE refusés', async () => {
    expect(await refus(db, `UPDATE delivery_note_orders SET empreinte_commande = 'x'`)).toMatch(/ne peut pas être modifiée/);
    await db.exec(`SET ROLE service_role`);
    expect(await refus(db, `DELETE FROM delivery_note_orders`)).toMatch(/permission denied/);
    expect(await refus(db, `TRUNCATE delivery_note_orders`)).toMatch(/permission denied/);
    await db.exec(`RESET ROLE`);
    expect(await refus(db, `TRUNCATE delivery_note_orders`)).toMatch(/ne peuvent pas être vidées/);
    expect(await refus(db, `TRUNCATE orders CASCADE`)).toMatch(/ne peuvent pas être vidées|bl_signatures/);
    expect((await un(db, `SELECT count(*)::int n FROM orders`)).n).toBe(5);
  });

  test('suppression d\'une commande liée à un BL : refusée ; commande sans BL : toujours supprimable', async () => {
    expect(await refus(db, `DELETE FROM orders WHERE id=$1`, [o1])).toMatch(/violates foreign key|delivery_note_orders/);
    expect(await refus(db, `DELETE FROM orders WHERE id=$1`, [o3])).toMatch(/violates foreign key|delivery_note_orders/);
    await db.query(`DELETE FROM orders WHERE id=$1`, [oAnnulee]);             // jamais liée
    await db.query(`DELETE FROM orders WHERE id=$1`, [oLegacy]);              // ancien BL : aucune liaison, suppression comme aujourd'hui
    expect((await un(db, `SELECT count(*)::int n FROM orders`)).n).toBe(3);
  });

  test('retrait d\'un BL NON signé (reprise après échec d\'un lot) : ses liaisons partent avec lui, sans droit DELETE sur la liaison', async () => {
    const r = await creer(db, 'livraison:nonce-5:client_z', [{ order_id: o3, empreinte: 'h3' }], 'client_z', 'Station Z');
    await db.exec(`SET ROLE service_role`);
    await db.query(`DELETE FROM delivery_notes WHERE id=$1`, [r.bl_id]);
    await db.exec(`RESET ROLE`);
    expect((await un(db, `SELECT count(*)::int n FROM delivery_note_orders WHERE delivery_note_id=$1`, [r.bl_id])).n).toBe(0);
  });

  test('BL SIGNÉ : ni lui, ni ses liaisons, ni ses commandes ne peuvent disparaître', async () => {
    const bl = await un(db, `SELECT id FROM delivery_notes WHERE cle_operation=$1`, [`commande:${o1}:initial`]);
    await db.query(`INSERT INTO bl_signatures (delivery_note_id, role, signature_data, signataire_nom, signed_by) VALUES ($1,'transporteur',$2,'Gérald','g@inca.re')`, [bl.id, PNG]);
    expect(await refus(db, `DELETE FROM delivery_notes WHERE id=$1`, [bl.id])).toMatch(/ne peut pas être supprimée/);
    expect(await refus(db, `DELETE FROM orders WHERE id=$1`, [o1])).toMatch(/violates foreign key|delivery_note_orders/);
    expect((await un(db, `SELECT count(*)::int n FROM delivery_note_orders WHERE delivery_note_id=$1`, [bl.id])).n).toBe(1);
  });

  test('clé d\'opération et BL figés : modification refusée, doublon de clé refusé', async () => {
    const bl = await un(db, `SELECT id FROM delivery_notes WHERE cle_operation=$1`, [`commande:${o1}:initial`]);
    expect(await refus(db, `UPDATE delivery_notes SET cle_operation = 'autre' WHERE id=$1`, [bl.id])).toMatch(/ne peut pas être modifié/);
    expect(await refus(db, `UPDATE delivery_notes SET contenu = '{}'::jsonb WHERE id=$1`, [bl.id])).toMatch(/figé/);
    expect(await refus(db, `INSERT INTO delivery_notes (delivery_id, pdv_key, pdv_name, storage_path, cle_operation) VALUES ('BL-9000','k','p','x', $1)`, [`commande:${o1}:initial`])).toMatch(/duplicate|unique/i);
    // plusieurs lignes sans clé (anciens BL, BL d'avant la migration) restent possibles
    await db.query(`INSERT INTO delivery_notes (delivery_id, pdv_key, pdv_name, storage_path) VALUES ('BL-9001','k','p','x'), ('BL-9002','k','p','y')`);
  });

  test('droits : ni anon ni authenticated sur la liaison et la fonction ; le serveur peut créer mais pas supprimer', async () => {
    for (const role of ['anon', 'authenticated']) {
      await db.exec(`SET ROLE ${role}`);
      expect(await refus(db, `SELECT * FROM delivery_note_orders`), role).toMatch(/permission denied/);
      expect(await refus(db, `SELECT * FROM bl_creer('k', NULL, 'k', 'P', '{"pdv":{}}'::jsonb, '[]'::jsonb)`), role).toMatch(/permission denied/);
      await db.exec(`RESET ROLE`);
    }
    await db.exec(`SET ROLE service_role`);
    const r = await un(db, `SELECT * FROM bl_creer('livraison:nonce-6:client_z', NULL, 'client_z', 'Z', '{"pdv":{"name":"Z"},"date":"d"}'::jsonb, '[]'::jsonb)`);
    expect(r.bl_cree).toBe(true);
    const droits = (await tous(db, `SELECT privilege_type FROM information_schema.role_table_grants WHERE table_name='delivery_note_orders' AND grantee='service_role' ORDER BY 1`)).map(x => x.privilege_type);
    expect(droits).toEqual(['INSERT', 'SELECT']);
    await db.exec(`RESET ROLE`);
  });

  test('statique : migration additive (aucune modification de données, numérotation non touchée)', () => {
    const code = SQL.split(/\r?\n/).filter(l => !l.trim().startsWith('--')).join('\n');
    expect(code).not.toMatch(/\bDROP\s+(TABLE|COLUMN)\b/i);
    expect(code).not.toMatch(/\bDELETE\s+FROM\b|\bUPDATE\s+\w+\s+SET\b|\bTRUNCATE\s+\w+\s*;/i);
    expect(code).not.toMatch(/setval|ALTER\s+SEQUENCE|bl_number\s*=|UPDATE\s+orders/i);
    expect(code).toMatch(/SET search_path = public, pg_temp/);
    expect(code).toMatch(/ON DELETE RESTRICT/);
  });
});

// ── Verrous ajoutés : anciens BL impossibles à recréer ou à renuméroter, aucun mélange de clients dans un BL ──────────────
test.describe.serial('Migration bl_commandes.sql : anciens BL et clients (base locale)', () => {
  let db: PGlite; let ancien1: string, ancien2: string, a1: string, a2: string, b1: string, sansCompte1: string, sansCompte2: string;
  const compteA = '00000000-0000-0000-0000-0000000000aa', compteB = '00000000-0000-0000-0000-0000000000bb';
  const commande = async (statut: string, bl: string | null, userId: string | null) =>
    (await un(db, `INSERT INTO orders (nom, status, bl_number, user_id) VALUES ('c', $1, $2, $3) RETURNING id`, [statut, bl, userId])).id;
  const bl = (cle: string, ids: string[]) => refus(db, `SELECT * FROM bl_creer($1, NULL, 'k', 'P', $2::jsonb, $3::jsonb)`, [cle, CONTENU('P'), JSON.stringify(ids.map(order_id => ({ order_id, empreinte: 'h' })))]);

  test.beforeAll(async () => {
    db = new PGlite(); await db.exec(ENV); await db.exec(SEQ); await db.exec(`SELECT setval('bl_number_seq', 90)`);
    await db.exec(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS user_id uuid`);
    await db.exec(SIG);
    ancien1 = await commande('livree', 'BL-0012', compteA); ancien2 = await commande('livree', 'BL-0090', null);
    a1 = await commande('confirmee', null, compteA); a2 = await commande('en_preparation', null, compteA);
    b1 = await commande('confirmee', null, compteB); sansCompte1 = await commande('confirmee', null, null); sansCompte2 = await commande('confirmee', null, null);
    await db.exec(SQL);
  });
  test.afterAll(async () => { await db.close(); });

  test('un ancien BL (commande avec numéro de BL) ne peut JAMAIS être recréé : refus par la base, aucun numéro consommé', async () => {
    const s = await seq(db);
    for (const o of [ancien1, ancien2]) expect(await bl('x-ancien-' + o, [o])).toMatch(/ancien BL.*signé sur papier/);
    expect(await bl('x-melange-ancien', [a1, ancien1])).toMatch(/ancien BL/);          // même mêlé à une commande valide
    expect(await seq(db)).toBe(s);
    expect((await un(db, `SELECT count(*)::int n FROM delivery_notes`)).n).toBe(0);
    expect((await un(db, `SELECT count(*)::int n FROM delivery_note_orders`)).n).toBe(0);
  });

  test('le numéro d\'un ancien BL ne peut ni être modifié, ni effacé, ni réattribué ; les autres mises à jour de commande restent libres', async () => {
    expect(await refus(db, `UPDATE orders SET bl_number = 'BL-9999' WHERE id=$1`, [ancien1])).toMatch(/ne peut pas être modifié/);
    expect(await refus(db, `UPDATE orders SET bl_number = NULL WHERE id=$1`, [ancien1])).toMatch(/ne peut pas être modifié/);
    expect(await refus(db, `UPDATE orders SET bl_number = bl_number, status = 'annulee' WHERE id=$1`, [ancien1])).toBeNull();   // inchangé : autorisé
    await db.query(`UPDATE orders SET status = 'livree', nom = 'autre' WHERE id=$1`, [ancien1]);                                  // statut, nom… : libres
    await db.query(`UPDATE orders SET status = 'en_preparation' WHERE id=$1`, [a1]);
    expect((await un(db, `SELECT bl_number FROM orders WHERE id=$1`, [ancien1])).bl_number).toBe('BL-0012');
    expect((await un(db, `SELECT bl_number FROM orders WHERE id=$1`, [ancien2])).bl_number).toBe('BL-0090');
  });

  test('un BL regroupé ne mélange jamais deux comptes clients ; même compte ou commandes sans compte : accepté', async () => {
    const s = await seq(db);
    expect(await bl('x-mix', [a1, b1])).toMatch(/même compte client/);
    expect(await bl('x-mix2', [a1, a2, b1])).toMatch(/même compte client/);
    expect(await seq(db)).toBe(s);
    expect(await bl('ok-A', [a1, a2])).toBeNull();                       // deux commandes du même compte
    expect(await bl('ok-0', [sansCompte1, sansCompte2])).toBeNull();     // commandes sans compte (saisies par l'équipe)
    expect(await bl('ok-A0', [a1, sansCompte1])).toBeNull();             // un compte + une commande sans compte : le contrôle du point de vente est fait par l'application
    expect(await seq(db)).toBe(s + 3);
  });

  test('statique : les anciens BL sont protégés sans que la migration ne modifie aucun numéro', () => {
    const code = SQL.split(/\r?\n/).filter(l => !l.trim().startsWith('--')).join('\n');
    expect(code).toMatch(/ancien BL/); expect(code).toMatch(/BEFORE UPDATE OF bl_number ON orders/);
    expect(code).not.toMatch(/UPDATE\s+orders\s+SET|setval|bl_number\s*=\s*/i);
  });
});
