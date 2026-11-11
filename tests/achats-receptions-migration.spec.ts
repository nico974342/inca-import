/**
 * Suivi des achats — réceptions PARTIELLES : migration achats_receptions_partielles.sql sur une base LOCALE (PGlite). Aucune connexion à Supabase,
 * aucune écriture en production. La base reproduit la production (phase 0 comprise) avec les VRAIES fonctions de réception, de PUMP et de stock.
 */
import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';

const lire = (f: string) => readFileSync(`supabase/migrations/${f}`, 'utf8');
const MIGRATION = lire('achats_receptions_partielles.sql');

const MIGRATIONS_AVANT = [
  'orders_bl_number.sql', 'order_items_price_snapshots.sql', 'order_items_picked_column.sql', 'stock_rpc_functions.sql', 'product_adjust_stock_rpc.sql',
  'product_adjust_stock_fix.sql', 'shipments_table.sql', 'shipments_annule_receptions_partielles.sql', 'shipment_items_dlc.sql', 'suppliers_table.sql', 'stock_reserve.sql',
  'order_update_checked.sql', 'order_update_checked_price_refresh.sql', 'price_groups.sql', 'suppliers_stable_id_matching.sql', 'dlc_lots.sql', 'products_nouveau.sql',
  'order_create_checked_active_client.sql', 'products_visible_catalogue.sql', 'client_product_access.sql', 'bl_sequence.sql', 'bl_signatures.sql', 'bl_commandes.sql', 'securite_phase0.sql',
];

const ENV = `
  CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN BYPASSRLS;
  GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
  ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
  ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO anon, authenticated, service_role;
  ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;
  CREATE SCHEMA auth; CREATE TABLE auth.users (id uuid PRIMARY KEY DEFAULT gen_random_uuid());
  CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT NULL::uuid $$;
  CREATE SCHEMA storage; CREATE TABLE storage.buckets (id text PRIMARY KEY, name text NOT NULL, public boolean DEFAULT false, file_size_limit bigint, allowed_mime_types text[]);
  GRANT USAGE ON SCHEMA auth, storage TO anon, authenticated, service_role;
  CREATE TABLE client_accounts (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), contact_request_id uuid, nom text NOT NULL, societe text, telephone text,
    email text, status text, notes text, created_at timestamptz DEFAULT now(), points_de_vente text, remise numeric, price_group_id uuid,
    CONSTRAINT client_accounts_email_key UNIQUE (email),
    CONSTRAINT client_accounts_status_check CHECK (status = ANY (ARRAY['prospect','en_attente','actif','suspendu'])));
  CREATE TABLE products (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text NOT NULL, slug text, category text, sku text, price_ht numeric,
    stock_quantity integer NOT NULL DEFAULT 0, tva_rate numeric, prix_achat_moyen_ht numeric, in_stock boolean DEFAULT true,
    visible_catalogue boolean NOT NULL DEFAULT true, seuil_reappro integer, delai_livraison_jours integer, units_per_carton integer,
    nouveau_eligible boolean NOT NULL DEFAULT false, premiere_entree_stock_le timestamptz, nouveau_mode text NOT NULL DEFAULT 'auto',
    nouveau_debut timestamptz, nouveau_fin timestamptz);
  CREATE TABLE orders (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid REFERENCES auth.users(id), nom text, societe text, telephone text, email text,
    status text DEFAULT 'en_attente', notes text, created_at timestamptz DEFAULT now(), invoice_path text, tva_rate numeric DEFAULT 0.085,
    CONSTRAINT orders_status_check CHECK (status = ANY (ARRAY['en_attente','confirmee','en_preparation','expediee','livree','annulee'])));
  CREATE TABLE order_items (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), order_id uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    product_id uuid REFERENCES products(id), product_name text NOT NULL, quantity integer NOT NULL, unit text, created_at timestamptz DEFAULT now());
  CREATE TABLE stock_receptions (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), supplier_name text NOT NULL, received_at date NOT NULL, notes text,
    created_at timestamptz NOT NULL DEFAULT now(), stock_applied boolean NOT NULL DEFAULT true);
  CREATE TABLE stock_reception_items (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), reception_id uuid NOT NULL REFERENCES stock_receptions(id) ON DELETE CASCADE,
    product_id uuid NOT NULL REFERENCES products(id), quantity integer NOT NULL, unit_cost_ht numeric NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
  CREATE TABLE commande_fournisseur_drafts (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), admin_email text, quantity int);
  CREATE TABLE admin_audit_logs (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), admin_email text NOT NULL, action text NOT NULL, target_type text,
    target_id text, target_label text, details jsonb, created_at timestamptz NOT NULL DEFAULT now());
  CREATE TABLE delivery_notes (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), delivery_id text NOT NULL,
    client_id uuid REFERENCES client_accounts(id) ON DELETE SET NULL, pdv_key text NOT NULL, pdv_name text NOT NULL,
    storage_path text NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
  ALTER TABLE delivery_notes ENABLE ROW LEVEL SECURITY; ALTER TABLE admin_audit_logs ENABLE ROW LEVEL SECURITY;
  ALTER TABLE client_accounts ENABLE ROW LEVEL SECURITY; ALTER TABLE orders ENABLE ROW LEVEL SECURITY;`;

const ADMIN = '11111111-1111-1111-1111-111111111111';
const ADMIN2 = '44444444-4444-4444-4444-444444444444';
const COMMERCIAL = '22222222-2222-2222-2222-222222222222';
const MEL: Record<string, string> = { [ADMIN]: 'admin@inca.re', [ADMIN2]: 'arnaud@inca.re', [COMMERCIAL]: 'clement@inca.re' };
const ROLE: Record<string, string> = { [ADMIN]: 'admin', [ADMIN2]: 'admin', [COMMERCIAL]: 'commercial' };

const exec = async (db: PGlite, q: string, p: unknown[] = []) => (await db.query<any>(q, p)).rows;
const un = async (db: PGlite, q: string, p: unknown[] = []) => (await exec(db, q, p))[0];
const as = async (db: PGlite, role: string, q: string, p: unknown[] = []) => {
  await db.exec(`SET ROLE ${role}`);
  try { return { rows: (await db.query<any>(q, p)).rows as any[], error: '' }; }
  catch (e: any) { return { rows: [] as any[], error: String(e.message ?? e) }; }
  finally { await db.exec('RESET ROLE'); }
};
const srv = (db: PGlite, q: string, p: unknown[] = []) => as(db, 'service_role', q, p);
const ERR = (e: string, code: string) => expect(e).toContain(code);
const uuid = () => crypto.randomUUID();
const aujourdhui = async (db: PGlite) => (await un(db, `SELECT ((now() AT TIME ZONE 'UTC') + interval '4 hours')::date::text d`)).d as string;

async function baseAchats(avecMigration = true): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(ENV);
  for (const f of MIGRATIONS_AVANT) { try { await db.exec(lire(f)); } catch (e: any) { throw new Error(`migration ${f} : ${e.message}`); } }
  await db.exec(`REVOKE ALL ON weekly_tasks FROM anon, authenticated`).catch(() => {});
  if (avecMigration) await db.exec(MIGRATION);
  return db;
}
const produit = async (db: PGlite, nom: string, stock = 0) => (await un(db, `INSERT INTO products (name, price_ht, stock_quantity, tva_rate, in_stock) VALUES ($1, 10, $2, 0.085, $2 > 0) RETURNING id`, [nom, stock])).id as string;
const commande = async (db: PGlite, lignes: { p: string; q: number; cout?: number | null; recu?: number | null }[], extra: { statut?: string; ref?: string } = {}) => {
  const s = (await un(db, `INSERT INTO shipments (supplier_name, reference, status) VALUES ('Fournisseur Test', $1, $2) RETURNING id`, [extra.ref ?? `REF-${uuid().slice(0, 6)}`, extra.statut ?? 'en_transit'])).id as string;
  const ids: string[] = [];
  for (const l of lignes) ids.push((await un(db, `INSERT INTO shipment_items (shipment_id, product_id, quantity, unit_cost_ht, received_quantity) VALUES ($1, $2, $3, $4, $5) RETURNING id`, [s, l.p, l.q, l.cout ?? 5, l.recu ?? null])).id);
  return { s, ids };
};
type Ligne = { shipment_item_id: string; quantity: unknown; unit_cost_ht?: unknown; dlc?: string | null };
const recevoir = async (db: PGlite, o: { cle?: string; s: string; lignes: Ligne[]; date?: string; bl?: string | null; notes?: string | null; acteur?: string }) => {
  const a = o.acteur ?? ADMIN;
  return srv(db, `SELECT reception_commande_enregistrer($1::uuid, $2::uuid, $3::date, $4, $5, $6::jsonb, $7::uuid, $8, $9) AS r`,
    [o.cle ?? uuid(), o.s, o.date ?? await aujourdhui(db), o.bl ?? null, o.notes ?? null, JSON.stringify(o.lignes.map(l => ({ unit_cost_ht: 5, ...l }))), a, MEL[a], ROLE[a]]);
};
const annuler = (db: PGlite, rec: string, motif: string | null, acteur = ADMIN) => srv(db, `SELECT reception_commande_annuler($1::uuid, $2, $3::uuid, $4, $5) AS r`, [rec, motif, acteur, MEL[acteur], ROLE[acteur]]);
const modifierQte = (db: PGlite, ligne: string, nouvelle: number, motif: string | null, acteur = ADMIN) => srv(db, `SELECT shipment_item_quantite_modifier($1::uuid, $2::int, $3, $4::uuid, $5, $6) AS r`, [ligne, nouvelle, motif, acteur, MEL[acteur], ROLE[acteur]]);
const stock = async (db: PGlite, p: string) => (await un(db, `SELECT stock_quantity s FROM products WHERE id = $1`, [p])).s as number;
const cumul = async (db: PGlite, l: string) => (await un(db, `SELECT received_quantity r FROM shipment_items WHERE id = $1`, [l])).r as number | null;
const etat = async (db: PGlite, s: string) => (await un(db, `SELECT shipment_reception_etat($1::uuid) e`, [s])).e;
const statutLogistique = async (db: PGlite, s: string) => (await un(db, `SELECT status FROM shipments WHERE id = $1`, [s])).status as string;
const instantane = async (db: PGlite) => ({
  produits: await exec(db, `SELECT id, stock_quantity, in_stock, prix_achat_moyen_ht FROM products ORDER BY id`),
  lignes: await exec(db, `SELECT id, quantity, received_quantity, unit_cost_ht FROM shipment_items ORDER BY id`),
  receptions: await exec(db, `SELECT id, shipment_id, annulee_le FROM stock_receptions ORDER BY id`),
  items: await exec(db, `SELECT id, reception_id, product_id, quantity, unit_cost_ht, shipment_item_id FROM stock_reception_items ORDER BY id`),
  commandes: await exec(db, `SELECT id, status, statut_avant_reception FROM shipments ORDER BY id`),
  journal: (await un(db, `SELECT count(*)::int n FROM admin_audit_logs`)).n,
});

// Relevé des colonnes qui EXISTENT déjà avant la migration : sert à prouver que l'existant est strictement identique après.
const commun = async (db: PGlite) => ({
  produits: await exec(db, `SELECT id, name, stock_quantity, in_stock, prix_achat_moyen_ht FROM products ORDER BY id`),
  commandes: await exec(db, `SELECT id, supplier_name, reference, status, eta, notes FROM shipments ORDER BY id`),
  lignes: await exec(db, `SELECT id, shipment_id, product_id, quantity, unit_cost_ht, received_quantity, dlc FROM shipment_items ORDER BY id`),
  receptions: await exec(db, `SELECT id, supplier_name, supplier_id, received_at, notes, stock_applied, created_at FROM stock_receptions ORDER BY id`),
  items: await exec(db, `SELECT id, reception_id, product_id, quantity, unit_cost_ht, dlc, created_at FROM stock_reception_items ORDER BY id`),
  journal: (await un(db, `SELECT count(*)::int n FROM admin_audit_logs`)).n,
});

test.describe.serial('Réceptions partielles — migration et fonctions (base locale)', () => {
  let db: PGlite;
  test.beforeAll(async () => { db = await baseAchats(); });
  test.afterAll(async () => { await db.close(); });

  test('préservation : une base de production-type (commandes, réceptions historiques, cumuls) est strictement identique après la migration ; migration rejouable', async () => {
    const avant = await baseAchats(false);
    const p1 = await produit(avant, 'Cola', 100); const p2 = await produit(avant, 'Chips', 50);
    const hist = await commande(avant, [{ p: p1, q: 100, recu: 100 }, { p: p2, q: 40, recu: 40 }], { statut: 'receptionne', ref: 'HIST' });
    const cours = await commande(avant, [{ p: p1, q: 60, recu: null }, { p: p2, q: 30, recu: 10 }], { statut: 'dedouanement', ref: 'COURS' });
    expect((await srv(avant, `SELECT reception_create($1, now()::date, 'historique', true, $2::jsonb)`, ['Fournisseur Test', JSON.stringify([{ product_id: p1, quantity: 100, unit_cost_ht: 4 }, { product_id: p2, quantity: 40, unit_cost_ht: 2 }])])).error).toBe('');
    expect((await srv(avant, `SELECT reception_create($1, '2026-01-10'::date, 'ancienne', false, $2::jsonb)`, ['Fournisseur Test', JSON.stringify([{ product_id: p1, quantity: 5, unit_cost_ht: 3 }])])).error).toBe('');
    expect((await un(avant, `SELECT count(*)::int n FROM stock_receptions`)).n).toBe(2);                           // les réceptions historiques existent bien avant la migration
    const photo = await commun(avant);
    await avant.exec(MIGRATION);
    expect(await commun(avant)).toEqual(photo);
    await avant.exec(MIGRATION);                                                                       // rejeu : aucune erreur, aucun changement
    expect(await commun(avant)).toEqual(photo);
    const apres = await exec(avant, `SELECT shipment_id, cle_idempotence, bl_fournisseur, created_by, annulee_le FROM stock_receptions`);
    expect(apres.every(r => Object.values(r).every(v => v === null))).toBe(true);                     // toutes les réceptions existantes restent « historiques »
    expect(await avant.query(`SELECT 1`)).toBeTruthy(); expect(hist.ids.length + cours.ids.length).toBe(4);
    await avant.close();
  });

  test('fermeture : fonctions réservées au serveur, tables d\'historique fermées et sans suppression, aucune fonction SECURITY DEFINER, search_path figé', async () => {
    const f = await exec(db, `SELECT p.oid::regprocedure::text sig, p.prosecdef, p.proconfig FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace
      AND p.proname IN ('reception_commande_enregistrer', 'reception_commande_annuler', 'shipment_item_quantite_modifier', 'shipment_reception_etat', 'shipment_reception_quantites',
                        'shipment_items_proteger', 'shipments_proteger', 'stock_receptions_proteger', 'stock_reception_items_proteger', 'achats_historique_proteger')`);
    expect(f).toHaveLength(10);
    for (const x of f) {
      expect(x.prosecdef, x.sig).toBe(false); expect(JSON.stringify(x.proconfig), x.sig).toContain('search_path=public, pg_temp');
      for (const r of ['anon', 'authenticated']) expect((await un(db, `SELECT has_function_privilege('${r}', '${x.sig}', 'EXECUTE') a`)).a, `${r} ${x.sig}`).toBe(false);
    }
    for (const sig of ['reception_commande_enregistrer(uuid, uuid, date, text, text, jsonb, uuid, text, text)', 'reception_commande_annuler(uuid, text, uuid, text, text)', 'shipment_item_quantite_modifier(uuid, integer, text, uuid, text, text)'])
      expect((await un(db, `SELECT has_function_privilege('service_role', '${sig}', 'EXECUTE') a`)).a, sig).toBe(true);
    for (const t of ['stock_reception_items_annulees', 'shipment_item_quantites_historique']) {
      expect((await un(db, `SELECT relrowsecurity r FROM pg_class WHERE relname = $1`, [t])).r).toBe(true);
      for (const r of ['anon', 'authenticated']) expect((await un(db, `SELECT has_table_privilege('${r}', '${t}', 'SELECT') a`)).a).toBe(false);
      expect((await un(db, `SELECT has_table_privilege('service_role', '${t}', 'DELETE') a`)).a).toBe(false);
    }
    expect((await as(db, 'anon', `SELECT reception_commande_enregistrer(gen_random_uuid(), gen_random_uuid(), now()::date, NULL, NULL, '[]'::jsonb, gen_random_uuid(), 'x', 'admin')`)).error).toContain('permission denied');
    expect((await as(db, 'authenticated', `SELECT reception_commande_annuler(gen_random_uuid(), 'motif', gen_random_uuid(), 'x', 'admin')`)).error).toContain('permission denied');
  });

  test('100 cartons en 3 livraisons (40, 30, 30) : stock +40/+30/+30 exactement une fois chacun, reste calculé, statut attente → partielle → intégrale, commande « réceptionnée » seulement à la fin', async () => {
    const p = await produit(db, 'Cola 33cl', 10); const c = await commande(db, [{ p, q: 100 }]);
    expect((await etat(db, c.s))).toMatchObject({ statut: 'attente', commande: 100, recu: 0, reste: 100, receptions: 0 });
    const r1 = await recevoir(db, { s: c.s, lignes: [{ shipment_item_id: c.ids[0], quantity: 40 }], bl: 'BL-001', notes: 'Première palette' });
    expect(r1.error).toBe('');
    expect(await stock(db, p)).toBe(50); expect(await cumul(db, c.ids[0])).toBe(40);
    expect(r1.rows[0].r.etat).toMatchObject({ statut: 'partielle', recu: 40, reste: 60, receptions: 1 });
    expect(await statutLogistique(db, c.s)).toBe('en_transit');                                        // le statut logistique n'a pas bougé : indépendant
    const r2 = await recevoir(db, { s: c.s, lignes: [{ shipment_item_id: c.ids[0], quantity: 30 }], bl: 'BL-002' });
    expect(await stock(db, p)).toBe(80); expect(await cumul(db, c.ids[0])).toBe(70);
    expect(r2.rows[0].r.etat).toMatchObject({ statut: 'partielle', recu: 70, reste: 30, receptions: 2 });
    expect(await statutLogistique(db, c.s)).toBe('en_transit');
    const r3 = await recevoir(db, { s: c.s, lignes: [{ shipment_item_id: c.ids[0], quantity: 30 }] });
    expect(await stock(db, p)).toBe(110); expect(await cumul(db, c.ids[0])).toBe(100);
    expect(r3.rows[0].r.etat).toMatchObject({ statut: 'integrale', recu: 100, reste: 0, receptions: 3, historique: false });
    expect(await statutLogistique(db, c.s)).toBe('receptionne');
    expect((await un(db, `SELECT statut_avant_reception s FROM shipments WHERE id = $1`, [c.s])).s).toBe('en_transit');
    // chaque réception est individuelle, rattachée, attribuée, datée, avec BL et commentaire
    const recs = await exec(db, `SELECT bl_fournisseur, notes, created_by_email, shipment_id, stock_applied, cle_idempotence IS NOT NULL cle, (SELECT sum(quantity)::int FROM stock_reception_items i WHERE i.reception_id = r.id) q FROM stock_receptions r WHERE shipment_id = $1 ORDER BY created_at, id`, [c.s]);
    expect(recs).toHaveLength(3);
    expect(recs.map(r => r.q).sort()).toEqual([30, 30, 40]);
    expect(recs.every(r => r.created_by_email === 'admin@inca.re' && r.shipment_id === c.s && r.stock_applied && r.cle)).toBe(true);
    expect(recs.find(r => r.q === 40)).toMatchObject({ bl_fournisseur: 'BL-001', notes: 'Première palette' });
    expect((await un(db, `SELECT count(*)::int n FROM admin_audit_logs WHERE action = 'reception.commande' AND target_id = $1`, [c.s])).n).toBe(3);
    // plus rien à recevoir : refus
    ERR((await recevoir(db, { s: c.s, lignes: [{ shipment_item_id: c.ids[0], quantity: 1 }] })).error, 'COMMANDE_DEJA_SOLDEE');
    expect(await stock(db, p)).toBe(110);
  });

  test('commande de plusieurs produits, lignes laissées à zéro, livraisons différentes par produit ; le statut ne devient intégral que lorsque TOUTES les lignes sont soldées', async () => {
    const [a, b, d] = [await produit(db, 'A', 0), await produit(db, 'B', 5), await produit(db, 'C', 0)];
    const c = await commande(db, [{ p: a, q: 100 }, { p: b, q: 60 }, { p: d, q: 20 }]);
    const r1 = await recevoir(db, { s: c.s, lignes: [{ shipment_item_id: c.ids[0], quantity: 40 }, { shipment_item_id: c.ids[1], quantity: 0 }, { shipment_item_id: c.ids[2], quantity: 20 }] });
    expect(r1.error).toBe('');
    expect([await stock(db, a), await stock(db, b), await stock(db, d)]).toEqual([40, 5, 20]);          // B laissé à zéro : stock inchangé
    expect([await cumul(db, c.ids[0]), await cumul(db, c.ids[1]), await cumul(db, c.ids[2])]).toEqual([40, null, 20]);
    expect(r1.rows[0].r.etat).toMatchObject({ statut: 'partielle', commande: 180, recu: 60, reste: 120 });
    expect((await un(db, `SELECT count(*)::int n FROM stock_reception_items WHERE reception_id = $1`, [r1.rows[0].r.reception_id])).n).toBe(2);   // la ligne à zéro ne crée aucune ligne
    await recevoir(db, { s: c.s, lignes: [{ shipment_item_id: c.ids[0], quantity: 60 }, { shipment_item_id: c.ids[1], quantity: 30 }] });
    expect((await etat(db, c.s)).statut).toBe('partielle'); expect(await statutLogistique(db, c.s)).toBe('en_transit');   // B manque encore 30
    const r3 = await recevoir(db, { s: c.s, lignes: [{ shipment_item_id: c.ids[1], quantity: 30 }] });
    expect(r3.rows[0].r.etat.statut).toBe('integrale'); expect(await statutLogistique(db, c.s)).toBe('receptionne');
    expect([await stock(db, a), await stock(db, b), await stock(db, d)]).toEqual([100, 65, 20]);
    ERR((await recevoir(db, { s: c.s, lignes: [{ shipment_item_id: c.ids[0], quantity: 0 }, { shipment_item_id: c.ids[1], quantity: 0 }] })).error, 'COMMANDE_DEJA_SOLDEE');
  });

  test('aucune quantité à enregistrer : refusé, rien n\'est écrit', async () => {
    const p = await produit(db, 'Zéro', 3); const c = await commande(db, [{ p, q: 10 }]); const avant = await instantane(db);
    ERR((await recevoir(db, { s: c.s, lignes: [{ shipment_item_id: c.ids[0], quantity: 0 }] })).error, 'AUCUNE_QUANTITE');
    expect(await instantane(db)).toEqual(avant);
  });

  test('livraison SUPÉRIEURE au reste : refusée (100 commandés, 80 reçus, 30 demandés), rien n\'est écrit ; exactement le reste est accepté', async () => {
    const p = await produit(db, 'Surplus', 0); const c = await commande(db, [{ p, q: 100 }]);
    await recevoir(db, { s: c.s, lignes: [{ shipment_item_id: c.ids[0], quantity: 80 }] });
    const avant = await instantane(db);
    const r = await recevoir(db, { s: c.s, lignes: [{ shipment_item_id: c.ids[0], quantity: 30 }] });
    ERR(r.error, 'DEPASSEMENT_COMMANDE'); expect(r.error).toContain('20 restant');
    expect(await instantane(db)).toEqual(avant);                                                     // ni stock, ni cumul, ni réception, ni journal
    expect(await stock(db, p)).toBe(80);
    expect((await recevoir(db, { s: c.s, lignes: [{ shipment_item_id: c.ids[0], quantity: 20 }] })).error).toBe('');
    expect(await stock(db, p)).toBe(100);
    // la quantité commandée n'a JAMAIS été augmentée automatiquement
    expect((await un(db, `SELECT quantity q FROM shipment_items WHERE id = $1`, [c.ids[0]])).q).toBe(100);
    expect((await un(db, `SELECT count(*)::int n FROM shipment_item_quantites_historique`)).n).toBe(0);
  });

  test('accepter un surplus : l\'administrateur modifie la commande (motif obligatoire, historique, journal), PUIS la réception passe ; un commercial ne peut rien ; jamais sous le déjà reçu', async () => {
    const p = await produit(db, 'Surplus2', 0); const c = await commande(db, [{ p, q: 100 }]);
    await recevoir(db, { s: c.s, lignes: [{ shipment_item_id: c.ids[0], quantity: 80 }] });
    ERR((await recevoir(db, { s: c.s, lignes: [{ shipment_item_id: c.ids[0], quantity: 30 }] })).error, 'DEPASSEMENT_COMMANDE');
    ERR((await modifierQte(db, c.ids[0], 110, null)).error, 'MOTIF_REQUIS');
    ERR((await modifierQte(db, c.ids[0], 110, 'ab')).error, 'MOTIF_REQUIS');
    ERR((await modifierQte(db, c.ids[0], 110, 'Surplus accepté', COMMERCIAL)).error, 'ACTION_INTERDITE');
    ERR((await modifierQte(db, c.ids[0], 70, 'Erreur de saisie')).error, 'QUANTITE_INFERIEURE_AU_RECU');
    ERR((await modifierQte(db, c.ids[0], 100, 'Pas de changement')).error, 'AUCUN_CHANGEMENT');
    ERR((await modifierQte(db, c.ids[0], 0, 'Zéro')).error, 'QUANTITE_INVALIDE');
    expect((await un(db, `SELECT quantity q FROM shipment_items WHERE id = $1`, [c.ids[0]])).q).toBe(100);
    const m = await modifierQte(db, c.ids[0], 110, 'Le fournisseur livre 10 cartons de plus, accord du 12/11');
    expect(m.error).toBe(''); expect(m.rows[0].r).toMatchObject({ ancienne: 100, nouvelle: 110 });
    expect(await un(db, `SELECT ancienne, nouvelle, motif, par_email FROM shipment_item_quantites_historique WHERE shipment_item_id = $1`, [c.ids[0]])).toEqual({ ancienne: 100, nouvelle: 110, motif: 'Le fournisseur livre 10 cartons de plus, accord du 12/11', par_email: 'admin@inca.re' });
    expect((await un(db, `SELECT details d FROM admin_audit_logs WHERE action = 'commande.quantite' AND target_id = $1`, [c.s])).d).toMatchObject({ ancienne: 100, nouvelle: 110 });
    expect((await recevoir(db, { s: c.s, lignes: [{ shipment_item_id: c.ids[0], quantity: 30 }] })).error).toBe('');
    expect(await stock(db, p)).toBe(110); expect((await etat(db, c.s)).statut).toBe('integrale');
  });

  test('solder une commande que le fournisseur ne livrera pas en entier : baisse justifiée jusqu\'au reçu → intégrale ; une hausse rouvre la commande (statut logistique restauré)', async () => {
    const p = await produit(db, 'Solde', 0); const c = await commande(db, [{ p, q: 100 }], { statut: 'arrive_port' });
    await recevoir(db, { s: c.s, lignes: [{ shipment_item_id: c.ids[0], quantity: 80 }] });
    expect((await modifierQte(db, c.ids[0], 80, 'Le fournisseur n\'a plus de stock : commande soldée')).error).toBe('');
    expect((await etat(db, c.s)).statut).toBe('integrale'); expect(await statutLogistique(db, c.s)).toBe('receptionne');
    ERR((await recevoir(db, { s: c.s, lignes: [{ shipment_item_id: c.ids[0], quantity: 1 }] })).error, 'COMMANDE_DEJA_SOLDEE');
    expect((await modifierQte(db, c.ids[0], 90, 'Finalement 10 cartons de plus')).error).toBe('');
    expect((await etat(db, c.s)).statut).toBe('partielle'); expect(await statutLogistique(db, c.s)).toBe('arrive_port');      // restauré, pas deviné
  });

  test('DOUBLE CLIC / renvoi après coupure réseau : même clé = une seule réception et UNE seule entrée en stock, réponse identique', async () => {
    const p = await produit(db, 'Double', 0); const c = await commande(db, [{ p, q: 100 }]);
    const cle = uuid(); const o = { cle, s: c.s, lignes: [{ shipment_item_id: c.ids[0], quantity: 40 }], bl: 'BL-X' };
    const a = await recevoir(db, o); const b = await recevoir(db, o); const c3 = await recevoir(db, o);
    expect([a.error, b.error, c3.error]).toEqual(['', '', '']);
    expect(a.rows[0].r.deja).toBe(false); expect(b.rows[0].r).toMatchObject({ deja: true, reception_id: a.rows[0].r.reception_id }); expect(c3.rows[0].r.deja).toBe(true);
    expect(await stock(db, p)).toBe(40); expect(await cumul(db, c.ids[0])).toBe(40);
    expect((await un(db, `SELECT count(*)::int n FROM stock_receptions WHERE shipment_id = $1`, [c.s])).n).toBe(1);
    expect((await un(db, `SELECT count(*)::int n FROM admin_audit_logs WHERE action = 'reception.commande' AND target_id = $1`, [c.s])).n).toBe(1);
    // même après une AUTRE réception entre-temps, le renvoi tardif de la première ne ré-applique rien
    await recevoir(db, { s: c.s, lignes: [{ shipment_item_id: c.ids[0], quantity: 30 }] });
    expect((await recevoir(db, o)).rows[0].r.deja).toBe(true); expect(await stock(db, p)).toBe(70);
    // clé réutilisée avec d'autres données, par un autre acteur ou sur une autre commande : refusé
    ERR((await recevoir(db, { ...o, lignes: [{ shipment_item_id: c.ids[0], quantity: 41 }] })).error, 'CLE_REUTILISEE_AUTRES_DONNEES');
    ERR((await recevoir(db, { ...o, acteur: ADMIN2 })).error, 'CLE_DEJA_UTILISEE');
    const autre = await commande(db, [{ p, q: 10 }]);
    ERR((await recevoir(db, { cle, s: autre.s, lignes: [{ shipment_item_id: autre.ids[0], quantity: 5 }] })).error, 'CLE_DEJA_UTILISEE');
    expect(await stock(db, p)).toBe(70);
  });

  test('ERREUR AU MILIEU de la transaction : tout est annulé (ni réception, ni lignes, ni stock, ni cumul, ni journal) ; le nouvel essai avec la MÊME clé aboutit', async () => {
    const p1 = await produit(db, 'Milieu1', 0); const p2 = await produit(db, 'Milieu2', 0);
    const c = await commande(db, [{ p: p1, q: 50 }, { p: p2, q: 50 }]); const avant = await instantane(db);
    // panne simulée APRÈS l'insertion de la réception et de ses lignes : la mise à jour du stock du second produit échoue
    await db.exec(`CREATE OR REPLACE FUNCTION test_panne() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'PANNE_SIMULEE'; END $$;
      CREATE TRIGGER trg_test_panne BEFORE UPDATE OF stock_quantity ON products FOR EACH ROW WHEN (NEW.id = '${p2}') EXECUTE FUNCTION test_panne();`);
    const cle = uuid(); const o = { cle, s: c.s, lignes: [{ shipment_item_id: c.ids[0], quantity: 10 }, { shipment_item_id: c.ids[1], quantity: 20 }], bl: 'BL-PANNE' };
    ERR((await recevoir(db, o)).error, 'PANNE_SIMULEE');
    expect(await instantane(db)).toEqual(avant);
    expect((await un(db, `SELECT count(*)::int n FROM stock_receptions WHERE cle_idempotence = $1`, [cle])).n).toBe(0);
    await db.exec(`DROP TRIGGER trg_test_panne ON products`);
    const ok = await recevoir(db, o);                                                                  // l'utilisateur réessaie avec la même clé
    expect(ok.error).toBe(''); expect(ok.rows[0].r.deja).toBe(false);
    expect([await stock(db, p1), await stock(db, p2)]).toEqual([10, 20]);
    expect((await recevoir(db, o)).rows[0].r.deja).toBe(true); expect([await stock(db, p1), await stock(db, p2)]).toEqual([10, 20]);
  });

  test('DEUX RÉCEPTIONS « SIMULTANÉES » préparées sur le même état (60 + 60 pour 100 commandés) : la seconde est validée contre le cumul RÉEL et refusée ; jamais de sur-réception', async () => {
    const p = await produit(db, 'Concurrence', 0); const c = await commande(db, [{ p, q: 100 }]);
    const lignes = [{ shipment_item_id: c.ids[0], quantity: 60 }];
    const [x, y] = [await recevoir(db, { s: c.s, lignes }), await recevoir(db, { s: c.s, lignes })];     // deux utilisateurs, deux clés, même état de départ
    expect([x.error === '', y.error === ''].filter(Boolean)).toHaveLength(1);
    ERR(x.error || y.error, 'DEPASSEMENT_COMMANDE');
    expect(await stock(db, p)).toBe(60); expect(await cumul(db, c.ids[0])).toBe(60);
    // l'ordre de prise des verrous est fixe (commande, lignes, produits) : pas d'interblocage entre commandes partageant un produit
    const src = MIGRATION.slice(MIGRATION.indexOf('CREATE OR REPLACE FUNCTION reception_commande_enregistrer'), MIGRATION.indexOf('-- ── 6.'));
    const ordre = ['FROM shipments WHERE id = p_shipment_id FOR UPDATE', 'FROM shipment_items WHERE shipment_id = p_shipment_id ORDER BY id FOR UPDATE', 'FROM products WHERE id = ANY (v_pids) ORDER BY id FOR UPDATE'].map(m => src.indexOf(m));
    expect(ordre.every(i => i > 0)).toBe(true); expect([...ordre].sort((a, b) => a - b)).toEqual(ordre);
    const annul = MIGRATION.slice(MIGRATION.indexOf('CREATE OR REPLACE FUNCTION reception_commande_annuler'), MIGRATION.indexOf('-- ── 7.'));
    const ordre2 = ['FROM shipments WHERE id = v_ship FOR UPDATE', 'FROM stock_receptions WHERE id = p_reception_id FOR UPDATE', 'FROM shipment_items WHERE shipment_id = v_ship ORDER BY id FOR UPDATE', 'FROM products WHERE id = ANY (v_pids) ORDER BY id FOR UPDATE'].map(m => annul.indexOf(m));
    expect(ordre2.every(i => i > 0)).toBe(true); expect([...ordre2].sort((a, b) => a - b)).toEqual(ordre2);
  });

  test('validations : quantité décimale, négative, texte, ligne inconnue, ligne d\'une autre commande, ligne en double, coût manquant ou négatif, DLC invalide, date future, commande annulée, droits', async () => {
    const p = await produit(db, 'Valid', 0); const c = await commande(db, [{ p, q: 100 }]); const autre = await commande(db, [{ p, q: 10 }]); const avant = await instantane(db);
    const L = (q: unknown, extra: Partial<Ligne> = {}): Ligne => ({ shipment_item_id: c.ids[0], quantity: q, ...extra });
    for (const q of [1.5, -3, '10', null, 'abc', 100000000]) ERR((await recevoir(db, { s: c.s, lignes: [L(q)] })).error, 'QUANTITE_INVALIDE');
    ERR((await recevoir(db, { s: c.s, lignes: [{ shipment_item_id: uuid(), quantity: 5 }] })).error, 'LIGNE_INCONNUE');
    ERR((await recevoir(db, { s: c.s, lignes: [{ shipment_item_id: autre.ids[0], quantity: 5 }] })).error, 'LIGNE_INCONNUE');
    ERR((await recevoir(db, { s: c.s, lignes: [{ shipment_item_id: 'pas-un-uuid', quantity: 5 }] })).error, 'LIGNE_INCONNUE');
    ERR((await recevoir(db, { s: c.s, lignes: [L(5), L(5)] })).error, 'LIGNE_EN_DOUBLE');
    ERR((await recevoir(db, { s: c.s, lignes: [L(5, { unit_cost_ht: undefined })] })).error, 'COUT_INVALIDE');
    ERR((await recevoir(db, { s: c.s, lignes: [L(5, { unit_cost_ht: -1 })] })).error, 'COUT_INVALIDE');
    ERR((await recevoir(db, { s: c.s, lignes: [L(5, { dlc: '2026-13-45' })] })).error, 'DLC_INVALIDE');
    ERR((await recevoir(db, { s: c.s, lignes: [L(5, { dlc: 'demain' })] })).error, 'DLC_INVALIDE');
    // formats que PostgreSQL convertirait quand même en date : seul le format AAAA-MM-JJ est accepté
    ERR((await recevoir(db, { s: c.s, lignes: [L(5, { dlc: '20261215' })] })).error, 'DLC_INVALIDE');
    ERR((await recevoir(db, { s: c.s, lignes: [L(5, { dlc: '2026-1-5' })] })).error, 'DLC_INVALIDE');
    ERR((await recevoir(db, { s: c.s, lignes: [L(5)], date: '2099-01-01' })).error, 'DATE_INVALIDE');
    ERR((await recevoir(db, { s: c.s, lignes: [L(5)], date: '1999-01-01' })).error, 'DATE_INVALIDE');
    ERR((await recevoir(db, { s: c.s, lignes: [L(5)], bl: 'x'.repeat(121) })).error, 'TEXTE_TROP_LONG');
    ERR((await recevoir(db, { s: c.s, lignes: [L(5)], acteur: COMMERCIAL })).error, 'ACTION_INTERDITE');
    ERR((await recevoir(db, { s: uuid(), lignes: [L(5)] })).error, 'COMMANDE_INTROUVABLE');
    ERR((await srv(db, `SELECT reception_commande_enregistrer(NULL, $1::uuid, now()::date, NULL, NULL, $2::jsonb, $3::uuid, 'a@b.c', 'admin')`, [c.s, JSON.stringify([L(5)]), ADMIN])).error, 'CLE_REQUISE');
    ERR((await srv(db, `SELECT reception_commande_enregistrer(gen_random_uuid(), $1::uuid, now()::date, NULL, NULL, '[]'::jsonb, $2::uuid, 'a@b.c', 'admin')`, [c.s, ADMIN])).error, 'LIGNES_REQUISES');
    ERR((await srv(db, `SELECT reception_commande_enregistrer(gen_random_uuid(), $1::uuid, now()::date, NULL, NULL, $2::jsonb, $3::uuid, 'a@b.c', 'client')`, [c.s, JSON.stringify([L(5)]), ADMIN])).error, 'ACTION_INTERDITE');
    await db.query(`UPDATE shipments SET status = 'annule' WHERE id = $1`, [c.s]);
    ERR((await recevoir(db, { s: c.s, lignes: [L(5)] })).error, 'COMMANDE_ANNULEE');
    expect({ ...(await instantane(db)), commandes: undefined }).toEqual({ ...avant, commandes: undefined });
  });

  test('PUMP et coûts : le prix de chaque livraison alimente le PUMP comme avant ; les prix fournisseurs de la commande ne sont jamais modifiés', async () => {
    const p = await produit(db, 'Pump', 0); const c = await commande(db, [{ p, q: 100, cout: 4 }]);
    await recevoir(db, { s: c.s, lignes: [{ shipment_item_id: c.ids[0], quantity: 40, unit_cost_ht: 4 }] });
    await recevoir(db, { s: c.s, lignes: [{ shipment_item_id: c.ids[0], quantity: 60, unit_cost_ht: 6 }] });
    expect(Number((await un(db, `SELECT prix_achat_moyen_ht x FROM products WHERE id = $1`, [p])).x)).toBeCloseTo((40 * 4 + 60 * 6) / 100, 4);
    expect(Number((await un(db, `SELECT unit_cost_ht x FROM shipment_items WHERE id = $1`, [c.ids[0]])).x)).toBe(4);       // prix fournisseur de la commande inchangé
  });

  test('ANNULATION administrateur : stock, cumul, statuts et PUMP régularisés ; la réception d\'origine reste (annulée, auteur, date, motif) avec ses lignes archivées ; journal complet', async () => {
    const p = await produit(db, 'Annul', 10); const c = await commande(db, [{ p, q: 100 }], { statut: 'dedouanement' });
    const r1 = (await recevoir(db, { s: c.s, lignes: [{ shipment_item_id: c.ids[0], quantity: 40, unit_cost_ht: 4 }], bl: 'BL-A' })).rows[0].r.reception_id as string;
    const r2 = (await recevoir(db, { s: c.s, lignes: [{ shipment_item_id: c.ids[0], quantity: 60, unit_cost_ht: 8 }], bl: 'BL-B' })).rows[0].r.reception_id as string;
    expect(await statutLogistique(db, c.s)).toBe('receptionne'); expect(await stock(db, p)).toBe(110);
    ERR((await annuler(db, r2, null)).error, 'MOTIF_REQUIS'); ERR((await annuler(db, r2, 'x')).error, 'MOTIF_REQUIS');
    ERR((await annuler(db, r2, 'Saisie sur la mauvaise commande', COMMERCIAL)).error, 'ACTION_INTERDITE');
    ERR((await annuler(db, uuid(), 'Inconnue')).error, 'RECEPTION_INTROUVABLE');
    const a = await annuler(db, r2, 'Saisie sur la mauvaise commande');
    expect(a.error).toBe('');
    expect(await stock(db, p)).toBe(50); expect(await cumul(db, c.ids[0])).toBe(40);
    expect(a.rows[0].r.etat).toMatchObject({ statut: 'partielle', recu: 40, reste: 60, receptions: 1 });
    expect(await statutLogistique(db, c.s)).toBe('dedouanement');                                     // statut logistique d'avant restauré
    expect(Number((await un(db, `SELECT prix_achat_moyen_ht x FROM products WHERE id = $1`, [p])).x)).toBeCloseTo(4, 4);       // PUMP recalculé sans la réception annulée
    expect(await un(db, `SELECT annulee_par, annulation_motif m, bl_fournisseur bl, created_by_email FROM stock_receptions WHERE id = $1`, [r2])).toEqual({ annulee_par: 'admin@inca.re', m: 'Saisie sur la mauvaise commande', bl: 'BL-B', created_by_email: 'admin@inca.re' });
    expect((await un(db, `SELECT count(*)::int n FROM stock_reception_items WHERE reception_id = $1`, [r2])).n).toBe(0);
    expect(await un(db, `SELECT sum(quantity)::int q, count(*)::int n FROM stock_reception_items_annulees WHERE reception_id = $1`, [r2])).toEqual({ q: 60, n: 1 });
    expect((await un(db, `SELECT details d FROM admin_audit_logs WHERE action = 'reception.annulation' AND target_id = $1`, [c.s])).d).toMatchObject({ reception_id: r2, motif: 'Saisie sur la mauvaise commande', auteur_initial: 'admin@inca.re' });
    ERR((await annuler(db, r2, 'Encore')).error, 'RECEPTION_DEJA_ANNULEE'); expect(await stock(db, p)).toBe(50);
    // correction = annulation + nouvelle saisie : les quantités repartent d'un cumul juste
    expect((await recevoir(db, { s: c.s, lignes: [{ shipment_item_id: c.ids[0], quantity: 60, unit_cost_ht: 8 }] })).error).toBe('');
    expect(await stock(db, p)).toBe(110); expect(await cumul(db, c.ids[0])).toBe(100);
    // la première réception reste annulable seule
    expect(r1).toBeTruthy();
  });

  test('ANNULATION refusée si une partie du stock a déjà été vendue, réservée ou déplacée : aucune régularisation incohérente, rien n\'est écrit', async () => {
    const p = await produit(db, 'Vendu', 0); const c = await commande(db, [{ p, q: 100 }]);
    const rec = (await recevoir(db, { s: c.s, lignes: [{ shipment_item_id: c.ids[0], quantity: 100 }] })).rows[0].r.reception_id as string;
    // 1) une partie livrée (stock physique descendu)
    await db.query(`UPDATE products SET stock_quantity = 70 WHERE id = $1`, [p]);
    let avant = await instantane(db);
    let r = await annuler(db, rec, 'Réception à annuler'); ERR(r.error, 'STOCK_DEJA_ENGAGE'); expect(r.error).toContain('Vendu'); expect(r.error).toContain('70');
    expect(await instantane(db)).toEqual(avant);
    // 2) stock physique suffisant mais RÉSERVÉ par des commandes en cours
    await db.query(`UPDATE products SET stock_quantity = 100 WHERE id = $1`, [p]);
    const o = (await un(db, `INSERT INTO orders (nom, email, status) VALUES ('x', 'x@x.fr', 'confirmee') RETURNING id`)).id;
    await db.query(`INSERT INTO order_items (order_id, product_id, product_name, quantity) VALUES ($1, $2, 'Vendu', 30)`, [o, p]);
    avant = await instantane(db);
    r = await annuler(db, rec, 'Réception à annuler'); ERR(r.error, 'STOCK_DEJA_ENGAGE'); expect(r.error).toContain('réservé 30');
    expect(await instantane(db)).toEqual(avant);
    // 3) l'engagement disparaît : l'annulation est alors possible
    await db.query(`UPDATE orders SET status = 'annulee' WHERE id = $1`, [o]);
    expect((await annuler(db, rec, 'Réception à annuler')).error).toBe(''); expect(await stock(db, p)).toBe(0);
  });

  test('PROTECTIONS DIRECTES : cumul, quantité, ligne reçue, commande reçue, réception rattachée, lignes de réception, historiques — aucune modification ni suppression silencieuse, même pour le serveur', async () => {
    const p = await produit(db, 'Protégé', 0); const c = await commande(db, [{ p, q: 100 }, { p: await produit(db, 'Libre', 0), q: 5 }]);
    const rec = (await recevoir(db, { s: c.s, lignes: [{ shipment_item_id: c.ids[0], quantity: 40 }] })).rows[0].r.reception_id as string;
    const avant = await instantane(db);
    ERR((await srv(db, `UPDATE shipment_items SET received_quantity = 100 WHERE id = $1`, [c.ids[0]])).error, 'CUMUL_PROTEGE');
    ERR((await srv(db, `UPDATE shipment_items SET received_quantity = 0 WHERE id = $1`, [c.ids[0]])).error, 'CUMUL_PROTEGE');
    ERR((await srv(db, `UPDATE shipment_items SET received_quantity = 3 WHERE id = $1`, [c.ids[1]])).error, 'CUMUL_PROTEGE');
    ERR((await srv(db, `UPDATE shipment_items SET quantity = 90 WHERE id = $1`, [c.ids[0]])).error, 'QUANTITE_PROTEGEE');
    // même avec le drapeau d'écriture des fonctions, le cumul ne peut jamais dépasser la quantité commandée
    ERR((await srv(db, `DO $$ BEGIN PERFORM set_config('inca.achats_ecriture', '1', true); UPDATE shipment_items SET received_quantity = 101 WHERE id = '${c.ids[0]}'; END $$`)).error, 'CUMUL_SUPERIEUR_COMMANDE');
    ERR((await srv(db, `DO $$ BEGIN PERFORM set_config('inca.achats_ecriture', '1', true); UPDATE shipment_items SET quantity = 30 WHERE id = '${c.ids[0]}'; END $$`)).error, 'CUMUL_SUPERIEUR_COMMANDE');
    ERR((await srv(db, `DELETE FROM shipment_items WHERE id = $1`, [c.ids[0]])).error, 'LIGNE_RECUE_NON_SUPPRIMABLE');
    ERR((await srv(db, `DELETE FROM shipment_items WHERE shipment_id = $1`, [c.s])).error, 'LIGNE_RECUE_NON_SUPPRIMABLE');            // comme la page de modification d'avant (suppression en bloc)
    ERR((await srv(db, `DELETE FROM shipments WHERE id = $1`, [c.s])).error, 'COMMANDE_RECUE_NON_SUPPRIMABLE');
    ERR((await srv(db, `DELETE FROM stock_receptions WHERE id = $1`, [rec])).error, 'RECEPTION_LIEE_COMMANDE');
    ERR((await srv(db, `UPDATE stock_receptions SET received_at = '2020-01-01' WHERE id = $1`, [rec])).error, 'RECEPTION_LIEE_COMMANDE');
    ERR((await srv(db, `UPDATE stock_receptions SET notes = 'réécrit', annulee_le = now(), annulee_par = 'x', annulation_motif = 'xxx' WHERE id = $1`, [rec])).error, 'RECEPTION_LIEE_COMMANDE');
    ERR((await srv(db, `UPDATE stock_reception_items SET quantity = 400 WHERE reception_id = $1`, [rec])).error, 'RECEPTION_LIEE_COMMANDE');
    ERR((await srv(db, `DELETE FROM stock_reception_items WHERE reception_id = $1`, [rec])).error, 'RECEPTION_LIEE_COMMANDE');
    ERR((await srv(db, `INSERT INTO stock_reception_items (reception_id, product_id, quantity, unit_cost_ht) VALUES ($1, $2, 5, 1)`, [rec, p])).error, 'RECEPTION_LIEE_COMMANDE');
    ERR((await srv(db, `UPDATE stock_reception_items SET shipment_item_id = $1::uuid WHERE reception_id = $2::uuid`, [c.ids[1], rec])).error, 'RECEPTION_LIEE_COMMANDE');
    expect((await srv(db, `TRUNCATE stock_receptions CASCADE`)).error).toMatch(/RECEPTION_NON_SUPPRIMABLE|permission denied/);   // refusé par le déclencheur ou par l'absence de droit sur les archives
    ERR((await srv(db, `TRUNCATE stock_reception_items`)).error, 'RECEPTION_NON_SUPPRIMABLE');
    expect((await srv(db, `TRUNCATE shipment_items CASCADE`)).error).toMatch(/LIGNE_RECUE_NON_SUPPRIMABLE|permission denied/);
    expect(await instantane(db)).toEqual(avant);                                                      // aucune de ces tentatives n'a eu le moindre effet
    // historiques et archives immuables
    await modifierQte(db, c.ids[1], 6, 'Un carton de plus');
    ERR((await srv(db, `UPDATE shipment_item_quantites_historique SET motif = 'réécrit'`)).error, 'HISTORIQUE_IMMUABLE');
    ERR((await srv(db, `DELETE FROM shipment_item_quantites_historique`)).error, 'permission denied');
    ERR((await db.exec(`UPDATE shipment_item_quantites_historique SET motif = 'réécrit'`).then(() => '', e => String(e.message))), 'HISTORIQUE_IMMUABLE');
    ERR((await db.exec(`DELETE FROM shipment_item_quantites_historique`).then(() => '', e => String(e.message))), 'HISTORIQUE_IMMUABLE');
    expect(await stock(db, p)).toBe(40); expect(await cumul(db, c.ids[0])).toBe(40);
    // permis comme avant : rapprochement fournisseur sur une réception rattachée, suppression d'une commande JAMAIS reçue
    expect((await srv(db, `UPDATE stock_receptions SET supplier_id = NULL WHERE id = $1`, [rec])).error).toBe('');
    const vide = await commande(db, [{ p, q: 10 }]);
    expect((await srv(db, `DELETE FROM shipments WHERE id = $1`, [vide.s])).error).toBe('');
    expect((await un(db, `SELECT count(*)::int n FROM shipment_items WHERE shipment_id = $1`, [vide.s])).n).toBe(0);
  });

  test('les anciennes fonctions de réception ne contournent plus rien : modifier ou supprimer une réception rattachée échoue ET annule tout (stock inchangé) ; les réceptions historiques gardent leur comportement', async () => {
    const p = await produit(db, 'Ancien', 0); const c = await commande(db, [{ p, q: 100 }]);
    const rec = (await recevoir(db, { s: c.s, lignes: [{ shipment_item_id: c.ids[0], quantity: 40 }] })).rows[0].r.reception_id as string;
    const avant = await instantane(db);
    ERR((await srv(db, `SELECT reception_delete($1::uuid)`, [rec])).error, 'RECEPTION_LIEE_COMMANDE');
    ERR((await srv(db, `SELECT reception_update($1::uuid, 'F', now()::date, 'n', true, $2::jsonb)`, [rec, JSON.stringify([{ product_id: p, quantity: 5, unit_cost_ht: 1 }])])).error, 'RECEPTION_LIEE_COMMANDE');
    expect(await instantane(db)).toEqual(avant); expect(await stock(db, p)).toBe(40);
    // réception historique (hors commande) : création, modification et suppression comme avant
    const h = (await srv(db, `SELECT reception_create('F', now()::date, 'x', true, $1::jsonb) r`, [JSON.stringify([{ product_id: p, quantity: 7, unit_cost_ht: 2 }])])).rows[0].r as string;
    expect(await stock(db, p)).toBe(47);
    expect((await srv(db, `SELECT reception_update($1::uuid, 'F', now()::date, 'x', true, $2::jsonb)`, [h, JSON.stringify([{ product_id: p, quantity: 9, unit_cost_ht: 2 }])])).error).toBe(''); expect(await stock(db, p)).toBe(49);
    expect((await srv(db, `SELECT reception_delete($1::uuid)`, [h])).error).toBe(''); expect(await stock(db, p)).toBe(40);
    ERR((await recevoir(db, { s: c.s, lignes: [{ shipment_item_id: c.ids[0], quantity: 60 }] })).error === '' ? 'ok' : 'ko', 'ok');
  });

  test('COMPATIBILITÉ avec l\'existant : commande « réceptionnée » avant le suivi par quantités (cumul incomplet) = intégrale historique, non réceptionnable ; cumul ancien repris ; commande déjà soldée par l\'ancien système', async () => {
    const p = await produit(db, 'Legacy', 100);
    // a) ancienne commande clôturée « Réceptionné » sans cumul par ligne : stock déjà compté
    const a = await commande(db, [{ p, q: 100, recu: null }], { statut: 'receptionne' });
    expect(await etat(db, a.s)).toMatchObject({ statut: 'integrale', historique: true, reste: 100 });
    ERR((await recevoir(db, { s: a.s, lignes: [{ shipment_item_id: a.ids[0], quantity: 10 }] })).error, 'COMMANDE_DEJA_SOLDEE');
    ERR((await modifierQte(db, a.ids[0], 120, 'Tentative')).error, 'COMMANDE_CLOTUREE_HISTORIQUE');
    expect(await stock(db, p)).toBe(100);
    // b) ancienne réception partielle (cumul seul, sans réception liée) : on continue depuis ce cumul
    const b = await commande(db, [{ p, q: 100, recu: 30 }], { statut: 'arrive_port' });
    expect(await etat(db, b.s)).toMatchObject({ statut: 'partielle', recu: 30, reste: 70, historique: false });
    ERR((await recevoir(db, { s: b.s, lignes: [{ shipment_item_id: b.ids[0], quantity: 71 }] })).error, 'DEPASSEMENT_COMMANDE');
    expect((await recevoir(db, { s: b.s, lignes: [{ shipment_item_id: b.ids[0], quantity: 70 }] })).error).toBe('');
    expect(await cumul(db, b.ids[0])).toBe(100); expect((await etat(db, b.s)).statut).toBe('integrale'); expect(await statutLogistique(db, b.s)).toBe('receptionne');
    // l'annulation de cette réception rend 70, pas 100 : le cumul ancien (30) est préservé
    const rec = (await un(db, `SELECT id FROM stock_receptions WHERE shipment_id = $1`, [b.s])).id as string;
    expect((await annuler(db, rec, 'Erreur de commande')).error).toBe('');
    expect(await cumul(db, b.ids[0])).toBe(30); expect((await etat(db, b.s)).statut).toBe('partielle'); expect(await statutLogistique(db, b.s)).toBe('arrive_port');
    // c) commande jamais reçue, ancien statut logistique quelconque : attente
    const c = await commande(db, [{ p, q: 10 }], { statut: 'commande' });
    expect((await etat(db, c.s)).statut).toBe('attente');
    // d) commande sans ligne
    const vide = (await un(db, `INSERT INTO shipments (supplier_name, status) VALUES ('F', 'commande') RETURNING id`)).id;
    expect((await etat(db, vide)).statut).toBe('attente');
  });

  test('UNITÉS : commande, réception et stock sont en cartons ; la base ne lit ni ne convertit jamais units_per_carton', async () => {
    const p = (await un(db, `INSERT INTO products (name, price_ht, stock_quantity, units_per_carton, in_stock) VALUES ('Carton de 24', 10, 0, 24, false) RETURNING id`)).id as string;
    const c = await commande(db, [{ p, q: 10 }]);
    await recevoir(db, { s: c.s, lignes: [{ shipment_item_id: c.ids[0], quantity: 4 }] });
    expect(await stock(db, p)).toBe(4);                                                                // 4 cartons, pas 96 unités
    expect(MIGRATION.replace(/--[^\n]*/g, '')).not.toMatch(/units_per_carton/);
  });

  test('sécurité de la migration : additive, aucune suppression de données, aucune TVA, aucun prix, aucune facture, aucune table de mouvements parallèle', () => {
    const code = MIGRATION.replace(/--[^\n]*/g, '');
    expect(code).not.toMatch(/\bDROP\s+TABLE\b|\bDROP\s+COLUMN\b|^\s*TRUNCATE\s+\w|\bDELETE\s+FROM\s+(shipments|shipment_items|stock_receptions|products|orders|admin_audit_logs)\b/im);
    expect(code).not.toMatch(/\btva\b|tva_rate|\bfactur|invoice|price_ht|prix_achat_moyen_ht\s*=/i);
    expect(code).not.toMatch(/UPDATE\s+shipment_items\s+SET\s+unit_cost_ht|UPDATE\s+shipments\s+SET\s+(supplier|reference)/i);
    expect(code).not.toMatch(/stock_mouvements|stock_lots/i);                                          // on réutilise stock_receptions / stock_reception_items
    expect(code).not.toMatch(/CREATE OR REPLACE FUNCTION (reception_create|reception_update|reception_delete|order_)/);   // mécanismes existants non réécrits
    expect(code.match(/SECURITY DEFINER/g)).toBeNull();
  });
});
