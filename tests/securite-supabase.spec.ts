/**
 * Phase 0 — correctifs de sécurité (supabase/migrations/securite_phase0.sql), testés sur une base LOCALE (PGlite) qui reproduit
 * les rôles Supabase et l'état constaté en production (droits, politiques RLS, vue, droits par défaut). Les VRAIES fonctions
 * de stock et de commande sont rejouées depuis les fichiers de migration. Aucune connexion à Supabase, aucune écriture en production.
 */
import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';

const lire = (f: string) => readFileSync(`supabase/migrations/${f}`, 'utf8');
const SQL = lire('securite_phase0.sql');

// Les vraies migrations des fonctions testées, dans l'ordre historique (la dernière définition l'emporte, comme en production).
const MIGRATIONS = [
  'orders_bl_number.sql', 'order_items_price_snapshots.sql', 'stock_rpc_functions.sql', 'product_adjust_stock_rpc.sql',
  'product_adjust_stock_fix.sql', 'shipments_table.sql', 'suppliers_table.sql', 'stock_reserve.sql',
  'order_update_checked.sql', 'order_update_checked_price_refresh.sql', 'price_groups.sql',
  'suppliers_stable_id_matching.sql', 'dlc_lots.sql', 'products_nouveau.sql',
];

// Rôles Supabase + droits par défaut identiques à la production (relevés en lecture seule : tables, séquences et fonctions
// ouvertes à anon, authenticated et service_role ; EXECUTE donné à PUBLIC sur toute fonction créée).
const ENV = `
  CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN BYPASSRLS;
  GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
  ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
  ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO anon, authenticated, service_role;
  ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;
  CREATE SCHEMA auth; CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
  GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role;

  CREATE TABLE client_accounts (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), nom text NOT NULL, email text, remise numeric, price_group_id uuid);
  CREATE TABLE products (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text NOT NULL, slug text, category text, sku text, price_ht numeric,
    stock_quantity integer NOT NULL DEFAULT 0, tva_rate numeric, prix_achat_moyen_ht numeric, in_stock boolean DEFAULT true,
    visible_catalogue boolean NOT NULL DEFAULT true, seuil_reappro integer, delai_livraison_jours integer, units_per_carton integer,
    nouveau_eligible boolean NOT NULL DEFAULT false, premiere_entree_stock_le timestamptz, nouveau_mode text NOT NULL DEFAULT 'auto',
    nouveau_debut timestamptz, nouveau_fin timestamptz);
  CREATE TABLE orders (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid, nom text, societe text, telephone text, email text,
    status text DEFAULT 'en_attente', notes text, created_at timestamptz DEFAULT now(), invoice_path text, tva_rate numeric);
  CREATE TABLE order_items (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), order_id uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    product_id uuid REFERENCES products(id), product_name text NOT NULL, quantity integer NOT NULL, unit text, created_at timestamptz DEFAULT now(),
    picked boolean NOT NULL DEFAULT false);
  CREATE TABLE stock_receptions (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), supplier_name text NOT NULL, received_at date NOT NULL, notes text,
    created_at timestamptz NOT NULL DEFAULT now(), stock_applied boolean NOT NULL DEFAULT true);
  CREATE TABLE stock_reception_items (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), reception_id uuid NOT NULL REFERENCES stock_receptions(id) ON DELETE CASCADE,
    product_id uuid NOT NULL REFERENCES products(id), quantity integer NOT NULL, unit_cost_ht numeric NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
  CREATE TABLE commande_fournisseur_drafts (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), admin_email text, quantity int);
  CREATE TABLE admin_audit_logs (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), admin_email text, action text);`;

// RLS et politiques tels que relevés en production.
const RLS = `
  ALTER TABLE products ENABLE ROW LEVEL SECURITY; ALTER TABLE orders ENABLE ROW LEVEL SECURITY; ALTER TABLE order_items ENABLE ROW LEVEL SECURITY;
  ALTER TABLE client_accounts ENABLE ROW LEVEL SECURITY; ALTER TABLE stock_receptions ENABLE ROW LEVEL SECURITY;
  ALTER TABLE stock_reception_items ENABLE ROW LEVEL SECURITY; ALTER TABLE admin_audit_logs ENABLE ROW LEVEL SECURITY;
  CREATE POLICY "Public read in-stock products" ON products FOR SELECT USING (in_stock = true AND visible_catalogue = true);
  CREATE POLICY "Users see own orders" ON orders FOR SELECT USING (auth.uid() = user_id);
  CREATE POLICY "Users insert own orders" ON orders FOR INSERT WITH CHECK (auth.uid() = user_id);
  CREATE POLICY "Users see own order items" ON order_items FOR SELECT USING (EXISTS (SELECT 1 FROM orders o WHERE o.id = order_items.order_id AND o.user_id = auth.uid()));
  CREATE POLICY "Users insert own order items" ON order_items FOR INSERT WITH CHECK (EXISTS (SELECT 1 FROM orders o WHERE o.id = order_items.order_id AND o.user_id = auth.uid()));`;

// Comme en production : les fonctions déjà fermées à anon (et seulement elles) ; order_update_checked et le déclencheur restent ouverts.
const ETAT_PROD_FONCTIONS = `
  REVOKE EXECUTE ON FUNCTION order_create_checked(jsonb, jsonb), reception_create(text, date, text, boolean, jsonb, uuid),
    reception_update(uuid, text, date, text, boolean, jsonb, uuid), reception_delete(uuid), recalc_pump(uuid[]), order_mark_livree(uuid),
    order_cancel_livree(uuid), product_adjust_stock(uuid, integer), price_group_set_default(uuid), stock_reserving_statuses()
    FROM PUBLIC, anon, authenticated;`;

// Tables du BL telles qu'en production : jamais ouvertes à anon/authenticated, et service_role volontairement limité
// (bl_signatures : ni suppression ni purge ; delivery_note_orders : insertion et lecture seulement).
const TABLES_BL_RESTREINTES = `
  CREATE TABLE bl_signatures (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), role text, annulee_le timestamptz);
  CREATE TABLE delivery_note_orders (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), order_id uuid);
  REVOKE ALL ON bl_signatures, delivery_note_orders FROM anon, authenticated;
  REVOKE DELETE, TRUNCATE, TRIGGER, REFERENCES ON bl_signatures FROM service_role;
  REVOKE UPDATE, DELETE, TRUNCATE, TRIGGER, REFERENCES ON delivery_note_orders FROM service_role;`;

/** Droits effectifs de service_role sur chaque table, vue et fonction du schéma public. */
const droitsService = async (db: PGlite) => JSON.stringify({
  tables: (await db.query<any>(`SELECT c.relname, (SELECT string_agg(p, ',' ORDER BY p) FROM unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) p
    WHERE has_table_privilege('service_role', c.oid, p)) droits FROM pg_class c WHERE c.relnamespace='public'::regnamespace AND c.relkind IN ('r','v') ORDER BY 1`)).rows,
  fonctions: (await db.query<any>(`SELECT p.proname||'('||pg_get_function_identity_arguments(p.oid)||')' f, has_function_privilege('service_role', p.oid, 'EXECUTE') x FROM pg_proc p
    WHERE p.pronamespace='public'::regnamespace AND p.prokind='f' ORDER BY 1`)).rows,
});

const as = async (db: PGlite, role: string, q: string, p: unknown[] = []) => {
  await db.exec(`SET ROLE ${role}`);
  try { const r = await db.query(q, p); return { rows: r.rows as any[], error: '' }; }
  catch (e: any) { return { rows: [] as any[], error: String(e.message ?? e) }; }
  finally { await db.exec('RESET ROLE'); }
};

async function creerBase(): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(ENV);
  for (const f of MIGRATIONS) {
    try { await db.exec(lire(f)); } catch (e: any) { throw new Error(`migration ${f} : ${e.message}`); }
  }
  await db.exec(RLS);
  await db.exec(ETAT_PROD_FONCTIONS);
  await db.exec(TABLES_BL_RESTREINTES);
  await db.exec(`INSERT INTO commande_fournisseur_drafts (admin_email, quantity) VALUES ('a@b.fr', 3)`);
  return db;
}

/** Scénario métier complet joué comme le fait le serveur (service_role) : commande, modification, livraison, annulation, réceptions, stock. */
async function scenario(db: PGlite) {
  const S = (q: string, p: unknown[] = []) => as(db, 'service_role', q, p);
  const ok = async (q: string, p: unknown[] = []) => { const r = await S(q, p); if (r.error) throw new Error(`${q.slice(0, 60)} → ${r.error}`); return r.rows; };
  const sortie: Record<string, unknown> = {};

  const p1 = (await ok(`INSERT INTO products (name, price_ht, stock_quantity, prix_achat_moyen_ht, tva_rate, in_stock) VALUES ('Cola', 10, 50, 4, 0.085, true) RETURNING id`))[0].id;
  const p2 = (await ok(`INSERT INTO products (name, price_ht, stock_quantity, prix_achat_moyen_ht, tva_rate, in_stock) VALUES ('Chips', 5, 20, 2, 0.085, true) RETURNING id`))[0].id;
  const ligne = (id: string, q: number, prix: number) => ({ product_id: id, product_name: 'x', quantity: q, unit: 'carton', price_ht_snapshot: prix, tva_rate_snapshot: 0.085, pump_snapshot: 3 });

  const c = (await ok(`SELECT * FROM order_create_checked($1::jsonb, $2::jsonb)`, [JSON.stringify({ nom: 'Client', email: 'c@x.fr', user_id: null }), JSON.stringify([ligne(p1, 10, 10), ligne(p2, 5, 5)])]))[0];
  sortie.creation = { cree: !!c.r_order_id, conflits: c.r_conflicts };
  const refus = (await ok(`SELECT * FROM order_create_checked($1::jsonb, $2::jsonb)`, [JSON.stringify({ nom: 'Client2' }), JSON.stringify([ligne(p1, 999, 10)])]))[0];
  sortie.survente_refusee = { cree: !!refus.r_order_id, conflits: (refus.r_conflicts ?? []).length };

  const u = (await ok(`SELECT * FROM order_update_checked($1::uuid, $2::jsonb)`, [c.r_order_id, JSON.stringify([ligne(p1, 12, 10), ligne(p2, 5, 5)])]))[0];
  sortie.modification = u.r_conflicts;
  sortie.disponible_avant_livraison = (await ok(`SELECT physical, reserved, available FROM product_availability WHERE product_id=$1`, [p1]))[0];

  await ok(`UPDATE orders SET status='confirmee' WHERE id=$1`, [c.r_order_id]);
  await ok(`SELECT order_mark_livree($1::uuid)`, [c.r_order_id]);
  sortie.apres_livraison = (await ok(`SELECT stock_quantity FROM products WHERE id=$1`, [p1]))[0];
  await ok(`SELECT order_cancel_livree($1::uuid)`, [c.r_order_id]);
  sortie.apres_annulation_livraison = (await ok(`SELECT stock_quantity FROM products WHERE id=$1`, [p1]))[0];

  const rec = (await ok(`SELECT reception_create('Fournisseur A', current_date, 'n', true, $1::jsonb, NULL) AS id`, [JSON.stringify([{ product_id: p1, quantity: 20, unit_cost_ht: 6, dlc: '2027-05-01' }])]))[0].id;
  sortie.apres_reception = (await ok(`SELECT stock_quantity, prix_achat_moyen_ht FROM products WHERE id=$1`, [p1]))[0];
  await ok(`SELECT reception_update($1::uuid, 'Fournisseur A', current_date, 'n2', true, $2::jsonb, NULL)`, [rec, JSON.stringify([{ product_id: p1, quantity: 10, unit_cost_ht: 6 }])]);
  sortie.apres_modif_reception = (await ok(`SELECT stock_quantity FROM products WHERE id=$1`, [p1]))[0];
  await ok(`SELECT reception_delete($1::uuid)`, [rec]);
  sortie.apres_suppression_reception = (await ok(`SELECT stock_quantity FROM products WHERE id=$1`, [p1]))[0];

  await ok(`SELECT product_adjust_stock($1::uuid, -3)`, [p2]);
  sortie.ajustement = (await ok(`SELECT stock_quantity FROM products WHERE id=$1`, [p2]))[0];
  sortie.nouveau_declencheur = (await ok(`SELECT premiere_entree_stock_le IS NOT NULL AS pose FROM products WHERE id=$1`, [p1]))[0];
  const g = (await ok(`INSERT INTO price_groups (name, is_default) VALUES ('Standard', false) RETURNING id`))[0].id;
  await ok(`SELECT price_group_set_default($1::uuid)`, [g]);
  sortie.groupe_par_defaut = (await ok(`SELECT is_default FROM price_groups WHERE id=$1`, [g]))[0];
  await ok(`INSERT INTO commande_fournisseur_drafts (admin_email, quantity) VALUES ('b@c.fr', 1)`);
  sortie.brouillons = (await ok(`SELECT count(*)::int n FROM commande_fournisseur_drafts`))[0];
  sortie.vue = (await ok(`SELECT count(*)::int n FROM product_availability`))[0];
  return sortie;
}

const TABLES_SENSIBLES = ['commande_fournisseur_drafts', 'products', 'orders', 'order_items', 'client_accounts', 'stock_receptions',
  'stock_reception_items', 'admin_audit_logs', 'price_groups', 'price_group_items', 'shipments', 'shipment_items', 'suppliers'];

test.describe.serial('Phase 0 — sécurité Supabase (base locale)', () => {
  let avant: PGlite; let apres: PGlite;
  let attendu: Record<string, unknown>;

  let droitsAvant: string;
  test.beforeAll(async () => { avant = await creerBase(); apres = await creerBase(); droitsAvant = await droitsService(apres); });
  test.afterAll(async () => { await avant.close(); await apres.close(); });

  test('AVANT correction : les défauts existent (brouillons ouverts, PUMP lisible, insertion de commande à prix libre, fonction ouverte)', async () => {
    expect((await as(avant, 'anon', `SELECT count(*)::int n FROM commande_fournisseur_drafts`)).rows[0].n).toBe(1);
    expect((await as(avant, 'anon', `DELETE FROM commande_fournisseur_drafts RETURNING 1`)).error).toBe('');
    await avant.exec(`INSERT INTO products (name, price_ht, stock_quantity, prix_achat_moyen_ht, in_stock) VALUES ('Visible', 10, 5, 4.2, true)`);
    const pump = await as(avant, 'anon', `SELECT prix_achat_moyen_ht, stock_quantity, seuil_reappro FROM products`);
    expect(pump.error).toBe(''); expect(Number(pump.rows[0].prix_achat_moyen_ht)).toBe(4.2);             // le coût d'achat est lisible publiquement
    const uid = '11111111-1111-1111-1111-111111111111';
    await avant.exec(`SELECT set_config('request.jwt.claim.sub', '${uid}', false)`);
    expect((await as(avant, 'authenticated', `INSERT INTO orders (user_id, nom, status) VALUES ('${uid}', 'pirate', 'livree') RETURNING id`)).error).toBe('');   // commande insérée sans contrôle
    expect((await as(avant, 'anon', `SELECT order_update_checked(gen_random_uuid(), '[{"product_id":null}]'::jsonb)`)).error).not.toMatch(/permission denied/i);   // fonction exécutable
    await avant.exec(`SELECT set_config('request.jwt.claim.sub', '', false)`);
    await avant.exec(`DELETE FROM orders; DELETE FROM products; INSERT INTO commande_fournisseur_drafts (admin_email, quantity) VALUES ('a@b.fr', 3)`);
  });

  test('le scénario métier (commande, modification, livraison, annulation, réceptions, stock, PUMP, droits) donne le même résultat AVANT la correction', async () => {
    attendu = await scenario(avant);
    expect(attendu.creation).toMatchObject({ cree: true });
    expect(attendu.survente_refusee).toMatchObject({ cree: false });
    expect(attendu.apres_livraison).toEqual({ stock_quantity: 38 });            // 50 − 12 livrés
    expect(attendu.apres_annulation_livraison).toEqual({ stock_quantity: 50 });
  });

  test('APRÈS correction : le même scénario donne EXACTEMENT les mêmes résultats (aucune régression sur stock, commandes, PUMP, vue)', async () => {
    await apres.exec(SQL);
    expect(await scenario(apres)).toEqual(attendu);
  });

  test('APRÈS correction : anon et authenticated sont refusés partout (tables, vue, séquences, fonctions) ; service_role garde tout', async () => {
    const uid = '22222222-2222-2222-2222-222222222222';
    await apres.exec(`SELECT set_config('request.jwt.claim.sub', '${uid}', false)`);
    for (const role of ['anon', 'authenticated']) {
      for (const t of [...TABLES_SENSIBLES, 'product_availability']) {
        expect((await as(apres, role, `SELECT 1 FROM ${t} LIMIT 1`)).error, `${role} lit ${t}`).toMatch(/permission denied/i);
      }
      expect((await as(apres, role, `SELECT prix_achat_moyen_ht FROM products`)).error, role).toMatch(/permission denied/i);           // le PUMP n'est plus lisible
      expect((await as(apres, role, `INSERT INTO orders (user_id, nom) VALUES ('${uid}', 'pirate')`)).error, role).toMatch(/permission denied/i);
      expect((await as(apres, role, `DELETE FROM commande_fournisseur_drafts`)).error, role).toMatch(/permission denied/i);
      expect((await as(apres, role, `SELECT order_update_checked(gen_random_uuid(), '[]')`)).error, role).toMatch(/permission denied/i);
      expect((await as(apres, role, `SELECT recalc_pump(ARRAY[]::uuid[])`)).error, role).toMatch(/permission denied/i);
      expect((await as(apres, role, `SELECT reception_delete(gen_random_uuid())`)).error, role).toMatch(/permission denied/i);
    }
    expect((await as(apres, 'service_role', `SELECT count(*)::int n FROM commande_fournisseur_drafts`)).error).toBe('');
    for (const t of TABLES_SENSIBLES) expect((await as(apres, 'service_role', `SELECT 1 FROM ${t} LIMIT 1`)).error, `service_role ${t}`).toBe('');
  });

  test("APRÈS correction : les droits de service_role sont EXACTEMENT les mêmes qu'avant (aucun droit rendu ni retiré, notamment sur les tables du BL)", async () => {
    expect(await droitsService(apres)).toBe(droitsAvant);
    expect((await apres.query<any>(`SELECT has_table_privilege('service_role','bl_signatures','DELETE') d, has_table_privilege('service_role','bl_signatures','TRUNCATE') t,
      has_table_privilege('service_role','delivery_note_orders','UPDATE') u, has_table_privilege('service_role','delivery_note_orders','DELETE') e`)).rows[0]).toEqual({ d: false, t: false, u: false, e: false });
  });

  test('APRÈS correction : RLS actif sur les brouillons ; politiques d\'insertion retirées, politiques de lecture conservées', async () => {
    expect((await apres.query<any>(`SELECT relrowsecurity FROM pg_class WHERE relname='commande_fournisseur_drafts'`)).rows[0].relrowsecurity).toBe(true);
    const pol = (await apres.query<any>(`SELECT polname FROM pg_policy ORDER BY polname`)).rows.map(r => r.polname);
    expect(pol).not.toContain('Users insert own orders'); expect(pol).not.toContain('Users insert own order items');
    expect(pol).toEqual(expect.arrayContaining(['Users see own orders', 'Users see own order items', 'Public read in-stock products']));
  });

  test('toutes les fonctions du schéma public ont un search_path figé et ne sont exécutables que par le serveur', async () => {
    const f = (await apres.query<any>(`SELECT p.proname, p.proconfig, has_function_privilege('anon', p.oid, 'EXECUTE') a, has_function_privilege('authenticated', p.oid, 'EXECUTE') u,
      has_function_privilege('service_role', p.oid, 'EXECUTE') s, (SELECT count(*) FROM aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) x WHERE x.grantee = 0)::int pub
      FROM pg_proc p WHERE p.pronamespace='public'::regnamespace AND p.prokind='f'`)).rows;
    const attenduSP = ['recalc_pump', 'reception_delete', 'order_mark_livree', 'order_cancel_livree', 'stock_reserving_statuses', 'product_adjust_stock',
      'price_group_set_default', 'order_create_checked', 'order_update_checked', 'reception_create', 'reception_update'];
    for (const n of attenduSP) expect(String(f.find((r: any) => r.proname === n)?.proconfig), n).toContain('search_path=public, pg_temp');
    for (const r of f) { expect(r.a, `anon exécute ${r.proname}`).toBe(false); expect(r.u, `authenticated exécute ${r.proname}`).toBe(false); expect(r.pub, `PUBLIC exécute ${r.proname}`).toBe(0); expect(r.s, `service_role ${r.proname}`).toBe(true); }
  });

  test('le déclencheur « Nouveau » continue de s\'exécuter malgré le retrait de EXECUTE', async () => {
    const id = (await as(apres, 'service_role', `INSERT INTO products (name, stock_quantity) VALUES ('Trig', 0) RETURNING id`)).rows[0].id;
    await as(apres, 'service_role', `UPDATE products SET stock_quantity = 5 WHERE id = $1`, [id]);
    expect((await as(apres, 'service_role', `SELECT premiere_entree_stock_le IS NOT NULL AS pose FROM products WHERE id=$1`, [id])).rows[0]).toEqual(attendu.nouveau_declencheur);
  });

  test('FUTUR : une table, une séquence et une fonction créées après la migration ne sont PAS ouvertes à anon / authenticated, mais le sont à service_role', async () => {
    await apres.exec(`CREATE TABLE crm_exemple (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), note text); CREATE SEQUENCE crm_seq;
      CREATE FUNCTION crm_fn() RETURNS int LANGUAGE sql AS $$ SELECT 1 $$;`);
    for (const role of ['anon', 'authenticated']) {
      expect((await as(apres, role, `SELECT * FROM crm_exemple`)).error, role).toMatch(/permission denied/i);
      expect((await as(apres, role, `INSERT INTO crm_exemple (note) VALUES ('x')`)).error, role).toMatch(/permission denied/i);
      expect((await as(apres, role, `SELECT nextval('crm_seq')`)).error, role).toMatch(/permission denied/i);
      expect((await as(apres, role, `SELECT crm_fn()`)).error, role).toMatch(/permission denied/i);
    }
    expect((await as(apres, 'service_role', `INSERT INTO crm_exemple (note) VALUES ('x') RETURNING id`)).error).toBe('');
    expect((await as(apres, 'service_role', `SELECT nextval('crm_seq')`)).error).toBe('');
    expect((await as(apres, 'service_role', `SELECT crm_fn() AS n`)).rows[0].n).toBe(1);
  });

  test('aucune donnée modifiée par la migration, et elle est rejouable sans erreur', async () => {
    const instantane = async (db: PGlite) => JSON.stringify(await Promise.all(['products', 'orders', 'order_items', 'stock_receptions', 'stock_reception_items', 'commande_fournisseur_drafts']
      .map(async t => (await db.query<any>(`SELECT * FROM ${t} ORDER BY id`)).rows)));
    const v = await instantane(apres);
    await apres.exec(SQL);
    expect(await instantane(apres)).toBe(v);
  });

  test('statique : aucune suppression de donnée ni de table, seules deux politiques sont retirées, aucune référence à la TVA ni à next_bl_number', () => {
    const code = SQL.split(/\r?\n/).map(l => l.replace(/--.*$/, '')).join('\n');
    expect(code).not.toMatch(/\b(DELETE\s+FROM|TRUNCATE|UPDATE\s+\w+\s+SET|DROP\s+(TABLE|COLUMN|FUNCTION|SCHEMA|VIEW|TRIGGER|INDEX))\b/i);
    expect(code.match(/DROP\s+POLICY/gi)?.length).toBe(2);
    expect(code).not.toMatch(/tva|next_bl_number/i);
    expect(code).toMatch(/^\s*BEGIN;/m); expect(code).toMatch(/^\s*COMMIT;/m);
  });
});
