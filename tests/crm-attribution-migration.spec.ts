/**
 * CRM étape 1 (M1) — migrations crm_attribution.sql et crm_attribution_remplissage.sql sur une base LOCALE (PGlite).
 * Aucune connexion à Supabase, aucune écriture en production. La base reproduit l'état de production APRÈS la phase 0 (droits fermés,
 * search_path figés) et rejoue les VRAIES fonctions de commande, de stock et de BL depuis les fichiers de migration.
 */
import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { actionsPossibles, messagePortefeuille, categorieAttribution, ventilerCA, type ActionPortefeuille } from '../src/lib/portefeuille';

const lire = (f: string) => readFileSync(`supabase/migrations/${f}`, 'utf8');
const M1 = lire('crm_attribution.sql');
const REMPLISSAGE = lire('crm_attribution_remplissage.sql');

const MIGRATIONS_AVANT = [
  'orders_bl_number.sql', 'order_items_price_snapshots.sql', 'order_items_picked_column.sql', 'stock_rpc_functions.sql', 'product_adjust_stock_rpc.sql',
  'product_adjust_stock_fix.sql', 'shipments_table.sql', 'suppliers_table.sql', 'stock_reserve.sql', 'order_update_checked.sql',
  'order_update_checked_price_refresh.sql', 'price_groups.sql', 'suppliers_stable_id_matching.sql', 'dlc_lots.sql', 'products_nouveau.sql',
  'order_create_checked_active_client.sql', 'products_visible_catalogue.sql', 'client_product_access.sql',
  'bl_sequence.sql', 'bl_signatures.sql', 'bl_commandes.sql', 'securite_phase0.sql',
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

const ADMIN = '11111111-1111-1111-1111-111111111111';     // un administrateur
const CLEMENT = '22222222-2222-2222-2222-222222222222';   // un commercial
const ARNAUD = '33333333-3333-3333-3333-333333333333';    // un autre responsable possible

const exec = async (db: PGlite, q: string, p: unknown[] = []) => (await db.query<any>(q, p)).rows;
const un = async (db: PGlite, q: string, p: unknown[] = []) => (await exec(db, q, p))[0];
/** Exécute avec les droits d'un rôle ; renvoie les lignes ou le message d'erreur. */
const as = async (db: PGlite, role: string, q: string, p: unknown[] = []) => {
  await db.exec(`SET ROLE ${role}`);
  try { return { rows: (await db.query<any>(q, p)).rows as any[], error: '' }; }
  catch (e: any) { return { rows: [] as any[], error: String(e.message ?? e) }; }
  finally { await db.exec('RESET ROLE'); }
};
const srv = (db: PGlite, q: string, p: unknown[] = []) => as(db, 'service_role', q, p);

async function baseAvantM1(): Promise<{ db: PGlite; ids: Record<string, string> }> {
  const db = new PGlite();
  await db.exec(ENV);
  for (const f of MIGRATIONS_AVANT) { try { await db.exec(lire(f)); } catch (e: any) { throw new Error(`migration ${f} : ${e.message}`); } }
  const cl = async (nom: string, email: string | null, statut = 'actif') => (await un(db, `INSERT INTO client_accounts (nom, societe, email, status) VALUES ($1, $1, $2, $3) RETURNING id`, [nom, email, statut])).id;
  const ids: Record<string, string> = {
    a: await cl('Client A', 'a@x.fr'), b: await cl('Client B', 'b@x.fr'), prospect: await cl('Prospect', 'p@x.fr', 'prospect'),
    dup1: await cl('Doublon 1', 'Dup@x.fr'), dup2: await cl('Doublon 2', 'dup@x.fr'),
  };
  ids.p1 = (await un(db, `INSERT INTO products (name, price_ht, stock_quantity, prix_achat_moyen_ht, tva_rate, in_stock) VALUES ('Cola', 10, 100, 4, 0.085, true) RETURNING id`)).id;
  ids.p2 = (await un(db, `INSERT INTO products (name, price_ht, stock_quantity, prix_achat_moyen_ht, tva_rate, in_stock) VALUES ('Chips', 5, 50, 2, 0.085, true) RETURNING id`)).id;
  // Commandes HISTORIQUES (avant M1), insérées directement comme l'étaient les anciennes
  const cmd = async (email: string | null, statut: string, nom = 'x') => (await un(db, `INSERT INTO orders (nom, email, status) VALUES ($1, $2, $3) RETURNING id`, [nom, email, statut])).id;
  ids.h_a = await cmd('a@x.fr', 'livree'); ids.h_a_variante = await cmd('  A@X.fr ', 'livree'); ids.h_a_annulee = await cmd('a@x.fr', 'annulee'); ids.h_b = await cmd('b@x.fr', 'livree');
  ids.h_aucune = await cmd('inconnu@x.fr', 'livree'); ids.h_sans_email = await cmd(null, 'livree'); ids.h_prospect = await cmd('p@x.fr', 'livree');
  for (const o of [ids.h_a, ids.h_b, ids.h_aucune]) await db.query(`INSERT INTO order_items (order_id, product_id, product_name, quantity, price_ht_snapshot, pump_snapshot) VALUES ($1, $2, 'Cola', 2, 10, 4)`, [o, ids.p1]);
  return { db, ids };
}

const ligne = (p: string, q: number, prix = 10) => ({ product_id: p, product_name: 'x', quantity: q, unit: 'carton', price_ht_snapshot: prix, tva_rate_snapshot: 0.085, pump_snapshot: 3 });
const creerCommande = (db: PGlite, email: string | null, items: any[], extra: Record<string, unknown> = {}) =>
  srv(db, `SELECT * FROM order_create_checked($1::jsonb, $2::jsonb)`, [JSON.stringify({ nom: 'Cli', email, ...extra }), JSON.stringify(items)]);
const attribuer = (db: PGlite, client: string, nouveau: string | null, action: string, acteur: string, role: string, motif: string | null = null, mel?: string) =>
  srv(db, `SELECT client_attribuer($1, $2, $3, $4, $5, $6, $7, $8) AS r`, [client, nouveau, nouveau ? (mel ?? `${nouveau.slice(0, 4)}@inca.re`) : null, action, acteur, `${acteur.slice(0, 4)}@inca.re`, role, motif]);


/** Valeurs attendues du rapport de correspondance, calculées comme l'opérateur le fait en production (même requête que le fichier de remplissage). */
async function attenduRemplissage(d: PGlite) {
  const r = await un(d, `WITH c AS (SELECT o.id, count(a.id) n FROM orders o LEFT JOIN client_accounts a ON lower(trim(a.email)) = lower(trim(o.email))
      WHERE o.client_id IS NULL AND o.attribution = 'historique' AND nullif(trim(o.email), '') IS NOT NULL GROUP BY o.id)
    SELECT count(*)::text candidats, (count(*) FILTER (WHERE n = 1))::text uniques, (count(*) FILTER (WHERE n = 0))::text aucune FROM c`);
  const e = await un(d, `SELECT md5(coalesce(string_agg(u.order_id::text || ':' || u.client_id::text, ',' ORDER BY u.order_id), '')) empreinte
    FROM (SELECT o.id AS order_id, (array_agg(a.id))[1] AS client_id FROM orders o JOIN client_accounts a ON lower(trim(a.email)) = lower(trim(o.email))
          WHERE o.client_id IS NULL AND o.attribution = 'historique' AND nullif(trim(o.email), '') IS NOT NULL GROUP BY o.id HAVING count(*) = 1) u`);
  return { candidats: r.candidats, uniques: r.uniques, aucune: r.aucune, empreinte: e.empreinte as string };
}
/** Lance le fichier de remplissage comme en production : valeurs attendues posées juste avant, remises à zéro juste après. Renvoie le message d'erreur ('' si réussi). */
async function remplir(d: PGlite, surcharge: Partial<Awaited<ReturnType<typeof attenduRemplissage>>> | 'sans-valeurs' = {}) {
  const reglage = (v: Record<string, string>) => d.exec(`SELECT set_config('inca.remplissage_attendu_candidats', '${v.candidats}', false), set_config('inca.remplissage_attendu_uniques', '${v.uniques}', false),
    set_config('inca.remplissage_attendu_aucune', '${v.aucune}', false), set_config('inca.remplissage_attendu_empreinte', '${v.empreinte}', false)`);
  const vide = { candidats: '', uniques: '', aucune: '', empreinte: '' };
  await reglage(surcharge === 'sans-valeurs' ? vide : { ...(await attenduRemplissage(d)), ...surcharge });
  try { await d.exec(REMPLISSAGE); return ''; }
  catch (e: any) { try { await d.exec('ROLLBACK'); } catch { /* déjà terminée */ } return String(e.message ?? e); }
  finally { await reglage(vide); }
}

test.describe.serial('CRM M1 — rattachement des commandes et attribution commerciale (base locale)', () => {
  let db: PGlite; let ids: Record<string, string>; let avant: any;
  const INSTANTANE = (d: PGlite) => Promise.all(['orders', 'order_items', 'client_accounts', 'products', 'delivery_notes', 'admin_audit_logs']
    .map(async t => [t, (await d.query<any>(`SELECT * FROM ${t} ORDER BY id`)).rows]));

  test.beforeAll(async () => {
    ({ db, ids } = await baseAvantM1());
    avant = {
      orders: await exec(db, `SELECT id, user_id, nom, societe, telephone, email, status, notes, created_at, invoice_path, tva_rate, bl_number FROM orders ORDER BY id`),
      clients: await exec(db, `SELECT id, nom, societe, email, status FROM client_accounts ORDER BY id`),
      sequence: await un(db, `SELECT last_value, is_called FROM bl_number_seq`),
    };
    await db.exec(M1);
  });
  test.afterAll(async () => { await db.close(); });

  test('M1 structure : aucune donnée existante modifiée ; toutes les commandes existantes sont « historique », sans responsable, sans client ; rejouable', async () => {
    const apres = async () => ({
      orders: await exec(db, `SELECT id, user_id, nom, societe, telephone, email, status, notes, created_at, invoice_path, tva_rate, bl_number FROM orders ORDER BY id`),
      clients: await exec(db, `SELECT id, nom, societe, email, status FROM client_accounts ORDER BY id`),
      sequence: await un(db, `SELECT last_value, is_called FROM bl_number_seq`),
    });
    expect(await apres()).toEqual(avant);
    const nouveaux = await exec(db, `SELECT attribution, rattachement_groupe, count(*)::int n, count(client_id)::int avec_client, count(responsable_id)::int avec_resp FROM orders GROUP BY 1, 2`);
    expect(nouveaux).toEqual([{ attribution: 'historique', rattachement_groupe: 'non_classe', n: 7, avec_client: 0, avec_resp: 0 }]);
    expect((await un(db, `SELECT count(*)::int n FROM client_accounts WHERE responsable_id IS NOT NULL OR rattachement_groupe IS NOT NULL OR parent_id IS NOT NULL`)).n).toBe(0);
    await db.exec(M1);                                     // rejeu
    expect(await apres()).toEqual(avant);
  });

  test('colonnes, contraintes et index attendus', async () => {
    const col = async (t: string) => (await exec(db, `SELECT column_name, is_nullable, column_default FROM information_schema.columns WHERE table_name=$1 AND column_name IN ('client_id','responsable_id','responsable_email','attribution','responsable_depuis','rattachement_groupe','rattachement_valide_par','rattachement_valide_le','parent_id') ORDER BY column_name`, [t]));
    const o = await col('orders');
    expect(o.map(c => c.column_name)).toEqual(['attribution', 'client_id', 'rattachement_groupe', 'responsable_email', 'responsable_id']);
    expect(o.find(c => c.column_name === 'attribution')).toMatchObject({ is_nullable: 'NO', column_default: null });
    expect(o.find(c => c.column_name === 'rattachement_groupe')).toMatchObject({ is_nullable: 'NO', column_default: null });   // pas de défaut : une insertion hors déclencheur échoue bruyamment
    expect((await col('client_accounts')).map(c => c.column_name)).toEqual(['parent_id', 'rattachement_groupe', 'rattachement_valide_le', 'rattachement_valide_par', 'responsable_depuis', 'responsable_email', 'responsable_id']);
    const idx = (await exec(db, `SELECT indexname FROM pg_indexes WHERE tablename IN ('orders','client_accounts')`)).map(r => r.indexname);
    for (const i of ['orders_client_id_idx', 'orders_responsable_id_idx', 'client_accounts_responsable_idx', 'client_accounts_parent_idx']) expect(idx).toContain(i);
    // contraintes de cohérence
    expect((await srv(db, `UPDATE orders SET attribution='n''importe quoi' WHERE id=$1`, [ids.h_a])).error).toMatch(/orders_attribution_check|ATTRIBUTION_FIGEE/);
    expect((await srv(db, `UPDATE orders SET rattachement_groupe='n''importe quoi' WHERE id=$1`, [ids.h_a])).error).toMatch(/orders_rattachement_groupe_check|CLASSIFICATION_FIGEE/);
    expect((await srv(db, `INSERT INTO client_accounts (nom, email, status, rattachement_groupe) VALUES ('x','x1@x.fr','actif','autre')`)).error).toMatch(/rattachement/);
    expect((await srv(db, `INSERT INTO client_accounts (nom, email, status, responsable_id) VALUES ('x','x2@x.fr','actif','${ADMIN}')`)).error).toMatch(/responsable_coherent/);   // id sans e-mail ni date : refusé
    expect((await srv(db, `UPDATE client_accounts SET parent_id = id WHERE id=$1`, [ids.a])).error).toMatch(/parent_distinct/);
  });

  test('DROITS : fonctions M1 exécutables par le serveur seulement ; search_path figé ; order_create_checked garde ses droits et son search_path ; nouvelles colonnes fermées à anon/authenticated', async () => {
    const f = await exec(db, `SELECT p.proname, p.proconfig, has_function_privilege('anon', p.oid, 'EXECUTE') a, has_function_privilege('authenticated', p.oid, 'EXECUTE') u,
      has_function_privilege('service_role', p.oid, 'EXECUTE') s, (SELECT count(*) FROM aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) x WHERE x.grantee = 0)::int pub
      FROM pg_proc p WHERE p.pronamespace='public'::regnamespace AND p.prokind='f'`);
    const m1 = ['orders_attribuer', 'orders_attribution_proteger', 'client_accounts_attribution_proteger', 'client_attribuer', 'clients_attribuer_lot', 'client_classer_groupe', 'clients_classer_groupe_lot', 'order_create_checked'];
    for (const n of m1) { const r = f.find((x: any) => x.proname === n); expect(r, n).toBeTruthy(); expect(String(r.proconfig), n).toContain('search_path=public, pg_temp'); }
    for (const r of f) { expect(r.a, `anon exécute ${r.proname}`).toBe(false); expect(r.u, `authenticated ${r.proname}`).toBe(false); expect(r.pub, `PUBLIC ${r.proname}`).toBe(0); }
    for (const n of ['client_attribuer', 'clients_attribuer_lot', 'client_classer_groupe', 'clients_classer_groupe_lot', 'order_create_checked']) expect(f.find((x: any) => x.proname === n).s, n).toBe(true);
    for (const role of ['anon', 'authenticated']) {
      expect((await as(db, role, `SELECT responsable_id, rattachement_groupe FROM client_accounts`)).error, role).toMatch(/permission denied/i);
      expect((await as(db, role, `SELECT client_id, responsable_id, attribution FROM orders`)).error, role).toMatch(/permission denied/i);
    }
  });

  test("order_create_checked : la SEULE différence avec la version précédente est l'enregistrement de client_id (code identique, commentaires et espaces mis à part)", async () => {
    const corps = (src: string) => {
      const d = src.indexOf('$function$', src.indexOf('CREATE OR REPLACE FUNCTION public.order_create_checked')) + '$function$'.length;
      return src.slice(d, src.indexOf('$function$', d));
    };
    const nettoyer = (c: string) => c.replace(/\r/g, '').split('\n').map(l => l.replace(/--.*$/, '')).join('').replace(/\s+/g, '');
    const ancien = nettoyer(corps(lire('client_product_access.sql')));
    const nouveauCorps = nettoyer(corps(M1));
    const attendu = ancien
      .replace('INSERTINTOorders(user_id,nom,societe,telephone,email,notes,status)', 'INSERTINTOorders(user_id,nom,societe,telephone,email,notes,status,client_id)')
      .replace("'en_attente')RETURNINGidINTOv_order_id;", "'en_attente',v_client_id)RETURNINGidINTOv_order_id;");
    expect(attendu).not.toBe(ancien);                      // les deux remplacements ont bien eu lieu
    expect(nouveauCorps).toBe(attendu);
    // et la fonction installée porte son search_path
    const def = (await un(db, `SELECT pg_get_functiondef(p.oid) d FROM pg_proc p WHERE p.proname = 'order_create_checked'`)).d;
    expect(def).toContain("SET search_path TO 'public', 'pg_temp'");
  });

  // ───────────────────────────── VERROUS du remplissage : bloqué si les données ont changé ou si une correspondance est ambiguë ─────────────────────────────
  test('REMPLISSAGE BLOQUÉ : sans valeurs attendues, si les données ont changé, si une correspondance est devenue ambiguë, ou si l\'empreinte diffère — aucune écriture dans tous ces cas', async () => {
    const etat = () => exec(db, `SELECT id, client_id, attribution, responsable_id FROM orders ORDER BY id`);
    const avantGarde = await etat();
    const attendu = await attenduRemplissage(db);
    expect(attendu).toMatchObject({ candidats: '6', uniques: '5', aucune: '1' });      // 7 commandes dont 1 sans e-mail ; 5 à correspondance unique ; 1 sans compte
    // (a) valeurs attendues absentes
    expect(await remplir(db, 'sans-valeurs')).toMatch(/REMPLISSAGE_BLOQUE.*valeurs attendues/);
    // (b) mauvais nombres attendus
    expect(await remplir(db, { candidats: '79' })).toMatch(/REMPLISSAGE_BLOQUE.*données ont changé/);
    expect(await remplir(db, { uniques: '4' })).toMatch(/REMPLISSAGE_BLOQUE.*données ont changé/);
    expect(await remplir(db, { aucune: '0' })).toMatch(/REMPLISSAGE_BLOQUE.*données ont changé/);
    // (c) empreinte différente
    expect(await remplir(db, { empreinte: 'd41d8cd98f00b204e9800998ecf8427e' })).toMatch(/REMPLISSAGE_BLOQUE.*empreinte/);
    // (d) une correspondance DEVIENT ambiguë : un second compte (casse différente, autorisé par l'unicité sensible à la casse) pour le même e-mail
    const intrus = (await un(db, `INSERT INTO client_accounts (nom, email, status) VALUES ('Intrus', 'B@X.fr', 'actif') RETURNING id`)).id;
    expect(await remplir(db, await attenduRemplissage(db).then(a => ({ ...a })))).toMatch(/REMPLISSAGE_BLOQUE.*ambiguë/);
    // seconde couche, indépendante du verrou : même exécutée SEULE (verrou contourné), l'instruction d'écriture ne rattache JAMAIS une commande ambiguë
    const ecriture = REMPLISSAGE.slice(REMPLISSAGE.indexOf('WITH cible AS ('), REMPLISSAGE.indexOf('WHERE o.id = cible.order_id;') + 'WHERE o.id = cible.order_id;'.length);
    expect(ecriture).toContain('HAVING count(*) = 1');
    const res = await db.exec(`BEGIN; SELECT set_config('inca.rattachement_historique', '1', true); ${ecriture} SELECT id, client_id FROM orders; ROLLBACK;`);
    const lecture = Object.fromEntries((res.find((r: any) => r.fields?.some((f: any) => f.name === 'client_id')) as any).rows.map((r: any) => [r.id, r.client_id]));
    expect(lecture[ids.h_b]).toBeNull();                      // b@x.fr est devenu ambigu (b@x.fr / B@X.fr) : non rattachée
    expect(lecture[ids.h_a]).toBe(ids.a);                     // les correspondances uniques, elles, le seraient
    expect((await un(db, `SELECT count(client_id)::int n FROM orders`)).n).toBe(0);      // transaction annulée : aucune trace
    await db.query(`DELETE FROM client_accounts WHERE id = $1`, [intrus]);
    // (e) les données ont changé depuis le rapport : l'e-mail d'un compte est modifié (la liste « commande → compte » n'est plus la même)
    const rapport = await attenduRemplissage(db);
    await db.query(`UPDATE client_accounts SET email = 'b2@x.fr' WHERE id = $1`, [ids.b]);
    expect(await remplir(db, rapport)).toMatch(/REMPLISSAGE_BLOQUE.*données ont changé/);
    await db.query(`UPDATE client_accounts SET email = 'b@x.fr' WHERE id = $1`, [ids.b]);
    // aucun de ces refus n'a écrit quoi que ce soit
    expect(await etat()).toEqual(avantGarde);
    expect((await un(db, `SELECT count(client_id)::int n FROM orders`)).n).toBe(0);
  });

  // ───────────────────────────── Remplissage des 78 correspondances (ici : 5 sur 8 commandes de test) ─────────────────────────────
  test('REMPLISSAGE : seules les correspondances EXACTES et UNIQUES sont rattachées ; casse/espaces tolérés ; inconnu et sans e-mail restent sans client ; rien d\'autre ne change', async () => {
    const avantRemp = await exec(db, `SELECT id, nom, societe, email, status, created_at, notes, tva_rate, bl_number, attribution, responsable_id, responsable_email FROM orders ORDER BY id`);
    const lignesAvant = await exec(db, `SELECT * FROM order_items ORDER BY id`);
    expect(await remplir(db)).toBe('');
    const liees = Object.fromEntries((await exec(db, `SELECT id, client_id FROM orders`)).map(r => [r.id, r.client_id]));
    expect(liees[ids.h_a]).toBe(ids.a); expect(liees[ids.h_a_variante]).toBe(ids.a); expect(liees[ids.h_a_annulee]).toBe(ids.a);      // annulée incluse, e-mail avec espaces/majuscules reconnu
    expect(liees[ids.h_b]).toBe(ids.b); expect(liees[ids.h_prospect]).toBe(ids.prospect);
    expect(liees[ids.h_aucune]).toBeNull();                 // aucun compte : JAMAIS deviné
    expect(liees[ids.h_sans_email]).toBeNull();
    // Aucune autre colonne modifiée : ni responsable, ni attribution, ni montants, ni statuts, ni lignes
    expect(await exec(db, `SELECT id, nom, societe, email, status, created_at, notes, tva_rate, bl_number, attribution, responsable_id, responsable_email FROM orders ORDER BY id`)).toEqual(avantRemp);
    expect(await exec(db, `SELECT * FROM order_items ORDER BY id`)).toEqual(lignesAvant);
    expect((await exec(db, `SELECT DISTINCT attribution FROM orders`)).map(r => r.attribution)).toEqual(['historique']);   // « Historique non attribué »
    expect((await un(db, `SELECT count(*)::int n FROM orders WHERE responsable_id IS NOT NULL`)).n).toBe(0);
    // rejouable : aucune modification supplémentaire (plus aucun candidat à rattacher : valeurs attendues recalculées)
    expect(await remplir(db)).toBe('');
    expect(Object.fromEntries((await exec(db, `SELECT id, client_id FROM orders`)).map(r => [r.id, r.client_id]))).toEqual(liees);
    // le réglage de transaction n'a pas fuité : le rattachement direct est de nouveau refusé
    expect((await srv(db, `UPDATE orders SET client_id = $1 WHERE id = $2`, [ids.b, ids.h_aucune])).error).toMatch(/CLIENT_FIGE/);
    expect((await srv(db, `UPDATE orders SET client_id = $1 WHERE id = $2`, [ids.b, ids.h_a])).error).toMatch(/CLIENT_FIGE/);
  });

  // ───────────────────────────── Nouvelles commandes : rattachement et attribution figée ─────────────────────────────
  test('NOUVELLE COMMANDE : client_id posé par order_create_checked ; responsable du moment figé ; l\'appelant ne peut ni le choisir ni le fausser', async () => {
    const stockAvant = Number((await un(db, `SELECT stock_quantity s FROM products WHERE id=$1`, [ids.p1])).s);
    // client A sans responsable
    const c1 = (await creerCommande(db, 'a@x.fr', [ligne(ids.p1, 2)])).rows[0];
    expect(c1.r_order_id).toBeTruthy();
    expect(await un(db, `SELECT client_id, responsable_id, responsable_email, attribution FROM orders WHERE id=$1`, [c1.r_order_id])).toEqual({ client_id: ids.a, responsable_id: null, responsable_email: null, attribution: 'sans_responsable' });
    // l'administrateur confie A à Clément ; la commande suivante porte Clément
    expect((await attribuer(db, ids.a, CLEMENT, 'attribution', ADMIN, 'admin', null, 'clement@inca.re')).error).toBe('');
    const c2 = (await creerCommande(db, 'a@x.fr', [ligne(ids.p1, 1)], { responsable_id: ARNAUD, attribution: 'manuelle', client_id: ids.b })).rows[0];   // tentatives de forcer : ignorées
    expect(await un(db, `SELECT client_id, responsable_id, responsable_email, attribution FROM orders WHERE id=$1`, [c2.r_order_id])).toEqual({ client_id: ids.a, responsable_id: CLEMENT, responsable_email: 'clement@inca.re', attribution: 'portefeuille' });
    // insertion directe avec un faux responsable : écrasée par le déclencheur
    const direct = await srv(db, `INSERT INTO orders (nom, email, status, responsable_id, responsable_email, attribution) VALUES ('d', 'a@x.fr', 'en_attente', $1, 'faux@inca.re', 'manuelle') RETURNING client_id, responsable_id, responsable_email, attribution`, [ARNAUD]);
    expect(direct.error).toBe(''); expect(direct.rows[0]).toEqual({ client_id: ids.a, responsable_id: CLEMENT, responsable_email: 'clement@inca.re', attribution: 'portefeuille' });
    // insertion directe : e-mail ambigu (deux comptes) ou inconnu → pas de client, pas de responsable
    for (const mel of ['dup@x.fr', 'personne@x.fr']) {
      const r = await srv(db, `INSERT INTO orders (nom, email, status) VALUES ('d', $1, 'en_attente') RETURNING client_id, responsable_id, attribution`, [mel]);
      expect(r.rows[0], mel).toEqual({ client_id: null, responsable_id: null, attribution: 'sans_responsable' });
      // même avec un faux responsable fourni par l'appelant : jamais retenu quand le client est inconnu ou ambigu
      const f = await srv(db, `INSERT INTO orders (nom, email, status, responsable_id, responsable_email, attribution) VALUES ('d', $1, 'en_attente', $2, 'faux@inca.re', 'manuelle') RETURNING client_id, responsable_id, responsable_email, attribution`, [mel, ARNAUD]);
      expect(f.error, mel).toBe(''); expect(f.rows[0], mel).toEqual({ client_id: null, responsable_id: null, responsable_email: null, attribution: 'sans_responsable' });
    }
    // comportement existant inchangé : comptes inactifs, e-mail absent, survente
    for (const mel of [null, 'p@x.fr', 'personne@x.fr']) expect((await creerCommande(db, mel, [ligne(ids.p1, 1)])).error, String(mel)).toMatch(/COMPTE_NON_ACTIF/);
    const refus = (await creerCommande(db, 'b@x.fr', [ligne(ids.p1, 999999)])).rows[0];
    expect(refus.r_order_id).toBeNull(); expect(refus.r_conflicts.length).toBe(1);
    expect(Number((await un(db, `SELECT stock_quantity s FROM products WHERE id=$1`, [ids.p1])).s)).toBe(stockAvant);   // le stock physique ne bouge pas à la création
  });

  test('STABILITÉ : un transfert de portefeuille ne change JAMAIS l\'attribution des commandes déjà passées', async () => {
    const vue = () => exec(db, `SELECT coalesce(responsable_email, '—') r, attribution, count(*)::int n FROM orders GROUP BY 1, 2 ORDER BY 1, 2`);
    const avantTransfert = await vue();
    expect((await attribuer(db, ids.a, ARNAUD, 'transfert', ADMIN, 'admin', 'Réorganisation des portefeuilles', 'arnaud@inca.re')).error).toBe('');
    expect(await vue()).toEqual(avantTransfert);                                  // rien n'a changé sur l'existant
    const c = (await creerCommande(db, 'a@x.fr', [ligne(ids.p1, 1)])).rows[0];
    expect(await un(db, `SELECT responsable_email, attribution FROM orders WHERE id=$1`, [c.r_order_id])).toEqual({ responsable_email: 'arnaud@inca.re', attribution: 'portefeuille' });
    // retrait : la commande suivante est « sans responsable », les précédentes gardent leur responsable
    expect((await attribuer(db, ids.a, null, 'retrait', ADMIN, 'admin', 'Départ du commercial')).error).toBe('');
    const c3 = (await creerCommande(db, 'a@x.fr', [ligne(ids.p1, 1)])).rows[0];
    expect((await un(db, `SELECT attribution FROM orders WHERE id=$1`, [c3.r_order_id])).attribution).toBe('sans_responsable');
    const parResp = Object.fromEntries((await vue()).map(r => [`${r.r}|${r.attribution}`, r.n]));
    expect(parResp['clement@inca.re|portefeuille']).toBe(2);                    // c2 et la commande directe
    expect(parResp['arnaud@inca.re|portefeuille']).toBe(1);
    expect(parResp['—|historique']).toBe(7);                                      // l'historique reste « non attribué »
  });

  test('PROTECTIONS : responsable, attribution et client d\'une commande sont figés (même pour le serveur) ; les autres champs restent modifiables ; la suppression d\'un compte garde l\'attribution', async () => {
    const o = (await un(db, `SELECT id FROM orders WHERE attribution='portefeuille' AND responsable_email='clement@inca.re' LIMIT 1`)).id;
    for (const [col, val] of [['responsable_id', ADMIN], ['responsable_email', 'x@inca.re'], ['attribution', 'manuelle'], ['attribution', 'sans_responsable']]) {
      expect((await srv(db, `UPDATE orders SET ${col} = $1 WHERE id = $2`, [val, o])).error, `${col}=${val}`).toMatch(/ATTRIBUTION_FIGEE|attribution/);
    }
    expect((await srv(db, `UPDATE orders SET responsable_id = NULL, responsable_email = NULL WHERE id = $1`, [o])).error).toMatch(/ATTRIBUTION_FIGEE|orders_attribution_coherente/);
    expect((await srv(db, `UPDATE orders SET client_id = $1 WHERE id = $2`, [ids.b, o])).error).toMatch(/CLIENT_FIGE/);
    expect((await srv(db, `UPDATE orders SET client_id = NULL WHERE id = $1`, [o])).error).toMatch(/CLIENT_FIGE/);       // le compte existe encore : on ne détache pas à la main
    // autres champs : modifiables comme avant (statut, notes, numéro de BL, cycle de livraison)
    expect((await srv(db, `UPDATE orders SET status = 'confirmee', notes = 'ok' WHERE id = $1`, [o])).error).toBe('');
    expect((await srv(db, `SELECT order_mark_livree($1)`, [o])).error).toBe('');
    expect((await srv(db, `SELECT order_cancel_livree($1)`, [o])).error).toBe('');
    // suppression d'un compte : le lien disparaît (ON DELETE SET NULL), l'attribution est conservée
    const z = (await un(db, `INSERT INTO client_accounts (nom, email, status) VALUES ('Z', 'z@x.fr', 'actif') RETURNING id`)).id;
    await attribuer(db, z, CLEMENT, 'attribution', ADMIN, 'admin', null, 'clement@inca.re');
    const oz = (await creerCommande(db, 'z@x.fr', [ligne(ids.p1, 1)])).rows[0].r_order_id;
    expect((await srv(db, `DELETE FROM client_accounts WHERE id = $1`, [z])).error).toBe('');
    expect(await un(db, `SELECT client_id, responsable_email, attribution FROM orders WHERE id=$1`, [oz])).toEqual({ client_id: null, responsable_email: 'clement@inca.re', attribution: 'portefeuille' });
  });

  test('PROTECTIONS du compte client : responsable et rattachement Groupe ne changent que par les fonctions journalisées ; le reste de la fiche reste modifiable', async () => {
    // un client qui a déjà un responsable (créé ainsi : l'insertion est autorisée)
    const avecResp = (await un(db, `INSERT INTO client_accounts (nom, email, status, responsable_id, responsable_email, responsable_depuis) VALUES ('Avec resp', 'ar@x.fr', 'actif', $1, 'clement@inca.re', now()) RETURNING id`, [CLEMENT])).id;
    for (const [q, cible] of [[`UPDATE client_accounts SET responsable_id = '${ADMIN}', responsable_email = 'a@inca.re', responsable_depuis = now() WHERE id = $1`, ids.b],
                              [`UPDATE client_accounts SET responsable_id = '${ADMIN}', responsable_email = 'a@inca.re' WHERE id = $1`, avecResp],
                              [`UPDATE client_accounts SET responsable_id = NULL, responsable_email = NULL, responsable_depuis = NULL WHERE id = $1`, avecResp],
                              [`UPDATE client_accounts SET rattachement_groupe = 'interne', rattachement_valide_par = 'a@inca.re', rattachement_valide_le = now() WHERE id = $1`, ids.b]] as const) {
      expect((await srv(db, q, [cible])).error, q).toMatch(/ATTRIBUTION_PROTEGEE|responsable_coherent/);
    }
    expect((await un(db, `SELECT responsable_email e FROM client_accounts WHERE id=$1`, [avecResp])).e).toBe('clement@inca.re');   // rien n'a bougé
    expect((await srv(db, `UPDATE client_accounts SET nom = 'Client B bis', telephone = '0692', status = 'actif', notes = 'ok', remise = 5 WHERE id = $1`, [ids.b])).error).toBe('');
    // création d'un prospect directement confié à son créateur : autorisé (c'est le cas « Clément crée un prospect »)
    expect((await srv(db, `INSERT INTO client_accounts (nom, email, status, responsable_id, responsable_email, responsable_depuis) VALUES ('Prospect Clément', 'pc@x.fr', 'prospect', $1, 'clement@inca.re', now())`, [CLEMENT])).error).toBe('');
  });

  test('DROITS DE L\'ATTRIBUTION : le commercial ne peut QUE prendre en charge, pour lui, un client sans responsable ; l\'administrateur attribue, transfère, retire (motif obligatoire) ; tout est refusé proprement sinon', async () => {
    const neuf = async (mel: string) => (await un(db, `INSERT INTO client_accounts (nom, email, status) VALUES ($1, $1, 'actif') RETURNING id`, [mel])).id;
    const k1 = await neuf('k1@x.fr'), k2 = await neuf('k2@x.fr');
    const lignesAudit = async () => (await un(db, `SELECT count(*)::int n FROM admin_audit_logs WHERE action = 'client.responsable'`)).n;
    const n0 = await lignesAudit();
    const refus = async (r: Promise<{ error: string }>, motif: RegExp) => expect((await r).error).toMatch(motif);
    // commercial : interdit sauf prise en charge pour soi
    await refus(attribuer(db, k1, CLEMENT, 'attribution', CLEMENT, 'commercial'), /ACTION_INTERDITE/);
    await refus(attribuer(db, k1, CLEMENT, 'transfert', CLEMENT, 'commercial', 'moi'), /ACTION_INTERDITE/);
    await refus(attribuer(db, k1, null, 'retrait', CLEMENT, 'commercial', 'moi'), /ACTION_INTERDITE/);
    await refus(attribuer(db, k1, ARNAUD, 'prise_en_charge', CLEMENT, 'commercial'), /ACTION_INTERDITE/);                     // pour un autre : non
    expect((await attribuer(db, k1, CLEMENT, 'prise_en_charge', CLEMENT, 'commercial', null, 'clement@inca.re')).error).toBe(''); // pour soi, client libre : oui
    await refus(attribuer(db, k1, ARNAUD, 'prise_en_charge', ARNAUD, 'commercial', null, 'arnaud@inca.re'), /DEJA_ATTRIBUE/);     // deuxième prise simultanée : refusée
    await refus(attribuer(db, k1, CLEMENT, 'prise_en_charge', CLEMENT, 'commercial', null, 'clement@inca.re'), /DEJA_ATTRIBUE/);
    // administrateur : cohérence et motif
    await refus(attribuer(db, k1, ARNAUD, 'attribution', ADMIN, 'admin', null, 'arnaud@inca.re'), /ACTION_INCOHERENTE/);          // déjà attribué
    await refus(attribuer(db, k1, ARNAUD, 'transfert', ADMIN, 'admin', null, 'arnaud@inca.re'), /MOTIF_REQUIS/);
    await refus(attribuer(db, k1, ARNAUD, 'transfert', ADMIN, 'admin', 'ok', 'arnaud@inca.re'), /MOTIF_REQUIS/);                  // motif trop court
    await refus(attribuer(db, k1, CLEMENT, 'transfert', ADMIN, 'admin', 'même personne', 'clement@inca.re'), /AUCUN_CHANGEMENT/);
    await refus(attribuer(db, k2, null, 'retrait', ADMIN, 'admin', 'sans responsable'), /ACTION_INCOHERENTE/);
    await refus(attribuer(db, k1, null, 'retrait', ADMIN, 'admin', null), /MOTIF_REQUIS/);
    await refus(attribuer(db, k2, ARNAUD, 'attribution', ADMIN, 'admin', null, ''), /RESPONSABLE_INVALIDE/);                      // responsable sans e-mail
    await refus(attribuer(db, '99999999-9999-9999-9999-999999999999', ARNAUD, 'attribution', ADMIN, 'admin'), /CLIENT_INTROUVABLE/);
    await refus(attribuer(db, k2, ARNAUD, 'bricoler', ADMIN, 'admin'), /ACTION_INCONNUE/);
    await refus(attribuer(db, k2, ARNAUD, 'attribution', ADMIN, 'client'), /ACTEUR_INVALIDE/);                                      // un client n'est pas un acteur
    await refus(attribuer(db, k2, ARNAUD, 'attribution', ADMIN, 'visiteur'), /ACTEUR_INVALIDE/);
    expect(await lignesAudit()).toBe(n0 + 1);                                                  // les refus n'ont rien journalisé ni modifié
    expect((await un(db, `SELECT responsable_email FROM client_accounts WHERE id=$1`, [k2])).responsable_email).toBeNull();
    expect((await attribuer(db, k1, ARNAUD, 'transfert', ADMIN, 'admin', 'Réorganisation', 'arnaud@inca.re')).error).toBe('');
    expect((await attribuer(db, k1, null, 'retrait', ADMIN, 'admin', 'Départ')).error).toBe('');
    expect((await attribuer(db, k2, ARNAUD, 'prise_en_charge', ADMIN, 'admin', null, 'arnaud@inca.re')).error).toMatch(/ACTION_INTERDITE/);   // un admin peut aussi se prendre en charge, mais pour LUI-même (ADMIN ≠ ARNAUD)
    expect((await attribuer(db, k2, ADMIN, 'prise_en_charge', ADMIN, 'admin', null, 'admin@inca.re')).error).toBe('');
    // JOURNAL : une ligne par changement réussi, avec l'acteur, l'ancien, le nouveau, le motif
    const j = await exec(db, `SELECT admin_email, details FROM admin_audit_logs WHERE action = 'client.responsable' AND target_id = $1 ORDER BY created_at, id`, [k1]);
    expect(j.map(x => x.details.action)).toEqual(['prise_en_charge', 'transfert', 'retrait']);
    expect(j[1].details).toMatchObject({ action: 'transfert', role_acteur: 'admin', ancien: { id: CLEMENT, email: 'clement@inca.re' }, nouveau: { id: ARNAUD, email: 'arnaud@inca.re' }, motif: 'Réorganisation' });
    expect(j[2].details).toMatchObject({ ancien: { id: ARNAUD }, nouveau: { id: null }, motif: 'Départ' });
    expect(j[0].admin_email).toBe('2222@inca.re');
    expect((await un(db, `SELECT responsable_depuis IS NULL AS vide FROM client_accounts WHERE id=$1`, [k1])).vide).toBe(true);
  });

  test('LOT (administrateur) : tout ou rien, ordre stable, clients déjà confiés ignorés ; refusé au commercial', async () => {
    const neuf = async (mel: string) => (await un(db, `INSERT INTO client_accounts (nom, email, status) VALUES ($1, $1, 'actif') RETURNING id`, [mel])).id;
    const l1 = await neuf('l1@x.fr'), l2 = await neuf('l2@x.fr'), l3 = await neuf('l3@x.fr');
    await attribuer(db, l2, ARNAUD, 'attribution', ADMIN, 'admin', null, 'arnaud@inca.re');
    await attribuer(db, l3, CLEMENT, 'attribution', ADMIN, 'admin', null, 'clement@inca.re');
    const lot = (q: string[], nouveau: string | null, role = 'admin', motif: string | null = 'Lot de test') =>
      srv(db, `SELECT clients_attribuer_lot($1::uuid[], $2, 'clement@inca.re', $3, 'adm@inca.re', $4, $5) r`, [`{${q.join(',')}}`, nouveau, ADMIN, role, motif]);
    expect((await lot([l1, l2], CLEMENT, 'commercial')).error).toMatch(/ACTION_INTERDITE/);
    const nAudit = async () => (await un(db, `SELECT count(*)::int n FROM admin_audit_logs WHERE action='client.responsable'`)).n;
    const n0 = await nAudit();
    // un identifiant inconnu fait échouer TOUT le lot : rien n'est modifié
    expect((await lot([l1, '99999999-9999-9999-9999-999999999999'], CLEMENT)).error).toMatch(/CLIENT_INTROUVABLE/);
    expect((await un(db, `SELECT responsable_id FROM client_accounts WHERE id=$1`, [l1])).responsable_id).toBeNull(); expect(await nAudit()).toBe(n0);
    expect((await lot([l1], CLEMENT, 'admin', null)).error).toMatch(/MOTIF_REQUIS/);
    expect((await lot([], CLEMENT)).error).toMatch(/LOT_INVALIDE/);
    const r = await lot([l1, l2, l3, l1], CLEMENT);                                // l1 libre → attribué ; l2 à Arnaud → transféré ; l3 déjà à Clément → ignoré ; doublon d'identifiant ignoré
    expect(r.error).toBe(''); expect(r.rows[0].r).toEqual({ attribues: 1, transferes: 1, ignores: 1 });
    expect((await exec(db, `SELECT id, responsable_id FROM client_accounts WHERE id IN ($1, $2, $3)`, [l1, l2, l3])).every(c => c.responsable_id === CLEMENT)).toBe(true);
    expect(await nAudit()).toBe(n0 + 2);                                           // une ligne par client réellement modifié
  });

  test('CLASSEMENT Groupe Incana / externe : manuel, administrateur seulement, journalisé ; « à classer » par défaut ; aucune déduction', async () => {
    expect((await un(db, `SELECT count(*)::int n FROM client_accounts WHERE rattachement_groupe IS NOT NULL`)).n).toBe(0);     // rien n'est classé automatiquement
    const cl = (v: string | null, role = 'admin', cible = ids.b) => srv(db, `SELECT client_classer_groupe($1, $2, 'adm@inca.re', $3, 'Validé par la direction') r`, [cible, v, role]);
    expect((await cl('interne', 'commercial')).error).toMatch(/ACTION_INTERDITE/);
    expect((await cl('partenaire')).error).toMatch(/VALEUR_INVALIDE/);
    expect((await cl('interne')).error).toBe('');
    expect(await un(db, `SELECT rattachement_groupe g, rattachement_valide_par p, rattachement_valide_le IS NOT NULL l FROM client_accounts WHERE id=$1`, [ids.b])).toEqual({ g: 'interne', p: 'adm@inca.re', l: true });
    expect((await cl('interne')).rows[0].r).toMatchObject({ inchange: true });
    expect((await cl('externe')).error).toBe('');
    const j = await exec(db, `SELECT details FROM admin_audit_logs WHERE action='client.rattachement_groupe' AND target_id=$1 ORDER BY created_at, id`, [ids.b]);
    expect(j.map(x => [x.details.ancien, x.details.nouveau])).toEqual([[null, 'interne'], ['interne', 'externe']]);        // l'inchangé n'est pas journalisé
    expect((await cl(null)).error).toBe('');                                       // remise « à classer »
    expect(await un(db, `SELECT rattachement_groupe g, rattachement_valide_par p FROM client_accounts WHERE id=$1`, [ids.b])).toEqual({ g: null, p: null });
    const lot = await srv(db, `SELECT clients_classer_groupe_lot($1::uuid[], 'externe', 'adm@inca.re', 'admin', 'Portefeuille indépendant') r`, [`{${ids.a},${ids.b}}`]);
    expect(lot.rows[0].r).toEqual({ classes: 2, inchanges: 0 });
    expect((await srv(db, `SELECT clients_classer_groupe_lot($1::uuid[], 'interne', 'x@inca.re', 'commercial', 'non') r`, [`{${ids.a}}`])).error).toMatch(/ACTION_INTERDITE/);
  });

  test('NON-RÉGRESSION commandes et BL : modification de commande, livraison, annulation, création de BL fonctionnent avec les nouvelles colonnes', async () => {
    const c = (await creerCommande(db, 'b@x.fr', [ligne(ids.p1, 3), ligne(ids.p2, 2)])).rows[0];
    const u = await srv(db, `SELECT * FROM order_update_checked($1::uuid, $2::jsonb)`, [c.r_order_id, JSON.stringify([ligne(ids.p1, 4), ligne(ids.p2, 2)])]);
    expect(u.error).toBe(''); expect(u.rows[0].r_conflicts == null || (u.rows[0].r_conflicts as any[]).length === 0).toBe(true);
    await srv(db, `UPDATE orders SET status = 'confirmee' WHERE id = $1`, [c.r_order_id]);
    const stock0 = Number((await un(db, `SELECT stock_quantity s FROM products WHERE id=$1`, [ids.p1])).s);
    expect((await srv(db, `SELECT order_mark_livree($1)`, [c.r_order_id])).error).toBe('');
    expect(Number((await un(db, `SELECT stock_quantity s FROM products WHERE id=$1`, [ids.p1])).s)).toBe(stock0 - 4);
    const bl = await srv(db, `SELECT * FROM bl_creer($1, NULL, 'k1', 'Station', $2::jsonb, $3::jsonb)`, [`commande:${c.r_order_id}:initial`, JSON.stringify({ pdv: { name: 'Station', items: [] } }), JSON.stringify([{ order_id: c.r_order_id, empreinte: 'h' }])]);
    expect(bl.error).toBe(''); expect(bl.rows[0].bl_cree).toBe(true);
    expect((await un(db, `SELECT bl_number FROM orders WHERE id=$1`, [c.r_order_id])).bl_number).toBeNull();      // le numéro est porté par delivery_notes ; l'ordre de grandeur de la table orders n'a pas bougé
    expect(await un(db, `SELECT client_id, attribution FROM orders WHERE id=$1`, [c.r_order_id])).toMatchObject({ client_id: ids.b });
    expect((await srv(db, `SELECT order_cancel_livree($1)`, [c.r_order_id])).error).toBe('');
    expect(Number((await un(db, `SELECT stock_quantity s FROM products WHERE id=$1`, [ids.p1])).s)).toBe(stock0);
  });

  test('ACCORD bibliothèque ↔ base : les actions proposées par actionsPossibles() sont exactement celles que la base accepte, pour chaque rôle et chaque situation', async () => {
    const ACTIONS: ActionPortefeuille[] = ['attribution', 'transfert', 'retrait', 'prise_en_charge'];
    let n = 0;
    for (const role of ['admin', 'commercial'] as const) {
      const acteur = role === 'admin' ? ADMIN : CLEMENT;
      for (const etat of ['libre', 'attribue'] as const) {
        const acceptees: ActionPortefeuille[] = [];
        for (const action of ACTIONS) {
          const mel = `accord${++n}@x.fr`;
          const client = (await un(db, `INSERT INTO client_accounts (nom, email, status) VALUES ($1, $1, 'actif') RETURNING id`, [mel])).id;
          if (etat === 'attribue') await attribuer(db, client, ARNAUD, 'attribution', ADMIN, 'admin', null, 'arnaud@inca.re');
          const nouveau = action === 'retrait' ? null : action === 'prise_en_charge' ? acteur : (action === 'transfert' ? CLEMENT : ARNAUD === acteur ? CLEMENT : ARNAUD);
          const r = await attribuer(db, client, nouveau, action, acteur, role, 'Motif de test', nouveau ? `${nouveau.slice(0, 4)}@inca.re` : undefined);
          if (r.error === '') acceptees.push(action);
        }
        expect(acceptees.sort(), `${role} / client ${etat}`).toEqual([...actionsPossibles(role, etat === 'libre' ? null : ARNAUD)].sort());
      }
    }
    // traduction des erreurs et libellés de statistiques
    expect(messagePortefeuille('error: DEJA_ATTRIBUE')).toMatch(/déjà un responsable/);
    expect(messagePortefeuille('n\'importe quoi')).toMatch(/rien n'a été modifié/);
    expect(categorieAttribution('historique', null)).toBe('Historique non attribué');
    expect(categorieAttribution('portefeuille', 'clement@inca.re')).toBe('clement@inca.re');
    expect(categorieAttribution('sans_responsable', null)).toBe('Client sans responsable');
  });

  test('NON-RÉGRESSION GLOBALE : le même scénario métier (commande, survente, modification, livraison, annulation, réception, ajustement) donne EXACTEMENT les mêmes résultats avec et sans M1', async () => {
    const scenario = async (d: PGlite, i: Record<string, string>) => {
      const S = async (q: string, p: unknown[] = []) => { const r = await srv(d, q, p); if (r.error) throw new Error(`${q.slice(0, 50)} → ${r.error}`); return r.rows; };
      const sortie: Record<string, unknown> = {};
      const c1 = (await creerCommande(d, 'a@x.fr', [ligne(i.p1, 10), ligne(i.p2, 5)])).rows[0];
      sortie.creation = { cree: !!c1.r_order_id, conflits: c1.r_conflicts };
      const refus = (await creerCommande(d, 'b@x.fr', [ligne(i.p1, 9999)])).rows[0];
      sortie.survente = { cree: !!refus.r_order_id, conflits: (refus.r_conflicts as any[]).map(x => [x.requested, x.available]) };
      sortie.inactifs = [null, 'p@x.fr', 'personne@x.fr'].map(() => 'COMPTE_NON_ACTIF');
      for (const mel of [null, 'p@x.fr', 'personne@x.fr']) expect((await creerCommande(d, mel, [ligne(i.p1, 1)])).error).toMatch(/COMPTE_NON_ACTIF/);
      sortie.modification = (await S(`SELECT * FROM order_update_checked($1::uuid, $2::jsonb)`, [c1.r_order_id, JSON.stringify([ligne(i.p1, 12), ligne(i.p2, 5)])]))[0];
      sortie.dispo = (await S(`SELECT physical, reserved, available FROM product_availability WHERE product_id = $1`, [i.p1]))[0];
      await S(`UPDATE orders SET status = 'confirmee' WHERE id = $1`, [c1.r_order_id]);
      await S(`SELECT order_mark_livree($1)`, [c1.r_order_id]);
      sortie.apres_livraison = (await S(`SELECT stock_quantity FROM products WHERE id = $1`, [i.p1]))[0];
      await S(`SELECT order_cancel_livree($1)`, [c1.r_order_id]);
      sortie.apres_annulation = (await S(`SELECT stock_quantity FROM products WHERE id = $1`, [i.p1]))[0];
      const rec = (await S(`SELECT reception_create('Fournisseur', current_date, 'n', true, $1::jsonb, NULL) AS id`, [JSON.stringify([{ product_id: i.p1, quantity: 20, unit_cost_ht: 6 }])]))[0].id;
      sortie.apres_reception = (await S(`SELECT stock_quantity, prix_achat_moyen_ht FROM products WHERE id = $1`, [i.p1]))[0];
      await S(`SELECT reception_delete($1::uuid)`, [rec]);
      await S(`SELECT product_adjust_stock($1::uuid, -3)`, [i.p2]);
      sortie.ajustement = (await S(`SELECT stock_quantity FROM products WHERE id = $1`, [i.p2]))[0];
      // état final des colonnes d'origine (les nouvelles colonnes n'existent pas sans M1)
      sortie.commandes = await S(`SELECT nom, email, status, bl_number, notes, tva_rate FROM orders ORDER BY created_at, email, status`);
      sortie.lignes = await S(`SELECT product_name, quantity, unit, price_ht_snapshot, tva_rate_snapshot, pump_snapshot, stock_decremented FROM order_items ORDER BY created_at, product_name, quantity`);
      return sortie;
    };
    const sans = await baseAvantM1();
    const avec = await baseAvantM1(); await avec.db.exec(M1); expect(await remplir(avec.db)).toBe('');
    try { expect(await scenario(avec.db, avec.ids)).toEqual(await scenario(sans.db, sans.ids)); }
    finally { await sans.db.close(); await avec.db.close(); }
  });

  // ───────────────────────────── Classification Groupe Incana / externe figée sur la commande ─────────────────────────────
  test('CLASSIFICATION FIGÉE : la classification du client est copiée sur la commande à sa création ; une modification ultérieure de la fiche ne change JAMAIS les commandes passées ; « non classé » par défaut et pour tout l\'historique', async () => {
    const neuf = async (mel: string) => (await un(db, `INSERT INTO client_accounts (nom, email, status) VALUES ($1, $1, 'actif') RETURNING id`, [mel])).id;
    const g = await neuf('g1@x.fr');
    const groupe = async (o: string) => (await un(db, `SELECT rattachement_groupe g FROM orders WHERE id=$1`, [o])).g;
    const passer = async () => (await creerCommande(db, 'g1@x.fr', [ligne(ids.p1, 1)])).rows[0].r_order_id as string;
    const classer = (v: string | null) => srv(db, `SELECT client_classer_groupe($1, $2, 'adm@inca.re', 'admin', 'test') r`, [g, v]);
    const o1 = await passer();                                   // client pas encore classé
    expect(await groupe(o1)).toBe('non_classe');
    expect((await classer('interne')).error).toBe('');
    const o2 = await passer();
    expect((await classer('externe')).error).toBe('');
    const o3 = await passer();
    expect((await classer(null)).error).toBe('');
    const o4 = await passer();
    expect([await groupe(o1), await groupe(o2), await groupe(o3), await groupe(o4)]).toEqual(['non_classe', 'interne', 'externe', 'non_classe']);
    // les changements de classification ne touchent à AUCUNE commande
    const avantChgt = await exec(db, `SELECT * FROM orders ORDER BY id`);
    await classer('interne'); await classer('externe');
    expect(await exec(db, `SELECT * FROM orders ORDER BY id`)).toEqual(avantChgt);
    // l'appelant ne peut pas choisir la classification, même par insertion directe
    for (const mel of ['g1@x.fr', 'personne@x.fr']) {
      const d = await srv(db, `INSERT INTO orders (nom, email, status, rattachement_groupe) VALUES ('d', $1, 'en_attente', 'interne') RETURNING rattachement_groupe g`, [mel]);
      expect(d.error, mel).toBe(''); expect(d.rows[0].g, mel).toBe(mel === 'g1@x.fr' ? 'externe' : 'non_classe');      // g1 est « externe » à cet instant ; l'inconnu reste « non classé »
    }
    // figée : modification refusée, même pour le serveur
    expect((await srv(db, `UPDATE orders SET rattachement_groupe = 'externe' WHERE id = $1`, [o1])).error).toMatch(/CLASSIFICATION_FIGEE/);
    expect((await srv(db, `UPDATE orders SET rattachement_groupe = 'x' WHERE id = $1`, [o1])).error).toMatch(/CLASSIFICATION_FIGEE|orders_rattachement_groupe_check/);
    // tout l'historique reste « non classé », même si son client est classé entre-temps (le client b a été classé plus haut)
    expect((await un(db, `SELECT count(*)::int n FROM orders WHERE attribution = 'historique' AND rattachement_groupe <> 'non_classe'`)).n).toBe(0);
    // seul l'administrateur classe (déjà vérifié plus haut) : un commercial est refusé
    expect((await srv(db, `SELECT client_classer_groupe($1, 'interne', 'c@inca.re', 'commercial', 'non') r`, [g])).error).toMatch(/ACTION_INTERDITE/);
  });

  // ───────────────────────────── Parcours de commande existants : client, administrateur, commercial ─────────────────────────────
  test('PARCOURS DE COMMANDE : client (compte connecté), administrateur et commercial (saisie rapide) — mêmes résultats, attribution au responsable du client et non à celui qui saisit', async () => {
    const neuf = async (mel: string) => (await un(db, `INSERT INTO client_accounts (nom, email, status) VALUES ($1, $1, 'actif') RETURNING id`, [mel])).id;
    const pc = await neuf('parcours@x.fr');
    await attribuer(db, pc, CLEMENT, 'attribution', ADMIN, 'admin', null, 'clement@inca.re');
    await srv(db, `SELECT client_classer_groupe($1, 'externe', 'adm@inca.re', 'admin', 'test') r`, [pc]);
    const compte = (await un(db, `INSERT INTO auth.users DEFAULT VALUES RETURNING id`)).id;
    const cache = (await un(db, `INSERT INTO products (name, price_ht, stock_quantity, in_stock, visible_catalogue) VALUES ('Produit masqué', 20, 50, true, false) RETURNING id`)).id;
    // charges utiles EXACTES envoyées par le site : commande.astro (client) et commande-rapide.astro (administrateur ET commercial : identiques)
    const charge = {
      client: { user_id: compte, nom: 'Cli', societe: 'Soc', telephone: '0692', email: 'parcours@x.fr', notes: null },
      administrateur: { user_id: null, nom: 'Cli', societe: 'Soc', telephone: '0692', email: 'parcours@x.fr', notes: 'saisi par admin', allow_hidden_products: true },
      commercial: { user_id: null, nom: 'Cli', societe: 'Soc', telephone: '0692', email: 'parcours@x.fr', notes: 'saisi par commercial', allow_hidden_products: true },
    };
    const stock0 = Number((await un(db, `SELECT stock_quantity s FROM products WHERE id=$1`, [ids.p1])).s);
    const cree: Record<string, string> = {};
    for (const [qui, p] of Object.entries(charge)) {
      const r = await srv(db, `SELECT * FROM order_create_checked($1::jsonb, $2::jsonb)`, [JSON.stringify(p), JSON.stringify([ligne(ids.p1, 1)])]);
      expect(r.error, qui).toBe(''); expect(r.rows[0].r_order_id, qui).toBeTruthy(); cree[qui] = r.rows[0].r_order_id;
      expect(await un(db, `SELECT client_id, responsable_email, attribution, rattachement_groupe FROM orders WHERE id=$1`, [cree[qui]]), qui)
        .toEqual({ client_id: pc, responsable_email: 'clement@inca.re', attribution: 'portefeuille', rattachement_groupe: 'externe' });
    }
    // le client connecté garde son user_id ; la saisie du personnel n'en a pas (comportement d'origine)
    expect((await un(db, `SELECT user_id FROM orders WHERE id=$1`, [cree.client])).user_id).toBe(compte);
    expect((await un(db, `SELECT user_id FROM orders WHERE id=$1`, [cree.commercial])).user_id).toBeNull();
    // produit masqué : refusé au client, autorisé à la saisie du personnel (comportement d'origine)
    const masque = (p: any) => srv(db, `SELECT * FROM order_create_checked($1::jsonb, $2::jsonb)`, [JSON.stringify(p), JSON.stringify([ligne(cache, 1, 20)])]);
    const rc = (await masque(charge.client)).rows[0]; expect(rc.r_order_id).toBeNull(); expect(rc.r_conflicts.length).toBe(1);
    expect((await masque(charge.administrateur)).rows[0].r_order_id).toBeTruthy(); expect((await masque(charge.commercial)).rows[0].r_order_id).toBeTruthy();
    // comptes non actifs, contact sans compte, e-mail absent : toujours refusés
    for (const p of [{ ...charge.client, email: 'p@x.fr' }, { ...charge.administrateur, email: 'contact-sans-compte@x.fr' }, { ...charge.commercial, email: null }]) {
      expect((await srv(db, `SELECT * FROM order_create_checked($1::jsonb, $2::jsonb)`, [JSON.stringify(p), JSON.stringify([ligne(ids.p1, 1)])])).error).toMatch(/COMPTE_NON_ACTIF/);
    }
    // modification de la commande, livraison et annulation : inchangées
    const o = cree.commercial;
    expect((await srv(db, `SELECT * FROM order_update_checked($1::uuid, $2::jsonb)`, [o, JSON.stringify([ligne(ids.p1, 2)])])).error).toBe('');
    await srv(db, `UPDATE orders SET status = 'confirmee' WHERE id = $1`, [o]);
    expect((await srv(db, `SELECT order_mark_livree($1)`, [o])).error).toBe('');
    expect((await srv(db, `SELECT order_cancel_livree($1)`, [o])).error).toBe('');
    expect(Number((await un(db, `SELECT stock_quantity s FROM products WHERE id=$1`, [ids.p1])).s)).toBe(stock0);     // le stock physique n'a pas bougé
    expect(await un(db, `SELECT responsable_email, attribution, rattachement_groupe FROM orders WHERE id=$1`, [o])).toEqual({ responsable_email: 'clement@inca.re', attribution: 'portefeuille', rattachement_groupe: 'externe' });
    // un transfert du portefeuille ne change pas ces commandes ; la suivante porte le nouveau responsable
    expect((await attribuer(db, pc, ARNAUD, 'transfert', ADMIN, 'admin', 'Réorganisation', 'arnaud@inca.re')).error).toBe('');
    expect((await un(db, `SELECT responsable_email e FROM orders WHERE id=$1`, [cree.client])).e).toBe('clement@inca.re');
    const apres = (await srv(db, `SELECT * FROM order_create_checked($1::jsonb, $2::jsonb)`, [JSON.stringify(charge.administrateur), JSON.stringify([ligne(ids.p1, 1)])])).rows[0].r_order_id;
    expect((await un(db, `SELECT responsable_email e FROM orders WHERE id=$1`, [apres])).e).toBe('arnaud@inca.re');
  });

  // ───────────────────────────── Statistiques : CA historique dans le global, hors performances individuelles ─────────────────────────────
  test('STATISTIQUES : le CA « Historique non attribué » reste dans le global et sort des performances individuelles ; la somme des catégories égale le global', async () => {
    const lignes = (await exec(db, `SELECT o.attribution, o.responsable_email, o.rattachement_groupe,
        coalesce(sum(i.quantity * i.price_ht_snapshot), 0)::float8 AS ca_ht
      FROM orders o LEFT JOIN order_items i ON i.order_id = o.id WHERE o.status <> 'annulee' GROUP BY o.id, o.attribution, o.responsable_email, o.rattachement_groupe`));
    const total = Number((await un(db, `SELECT coalesce(sum(i.quantity * i.price_ht_snapshot), 0)::float8 s FROM order_items i JOIN orders o ON o.id = i.order_id WHERE o.status <> 'annulee'`)).s);
    const v = ventilerCA(lignes as any);
    expect(v.global).toBeCloseTo(total, 6);
    expect(v.historiqueNonAttribue.ca).toBeGreaterThan(0);                          // l'historique pèse dans le global…
    expect(v.historiqueNonAttribue.commandes).toBeGreaterThan(0);
    expect(v.performancesIndividuelles + v.historiqueNonAttribue.ca + v.sansResponsable.ca).toBeCloseTo(v.global, 6);   // …et la somme des catégories égale le global
    expect(Object.values(v.parResponsable).reduce((s, r) => s + r.ca, 0)).toBeCloseTo(v.performancesIndividuelles, 6);
    expect(Object.keys(v.parResponsable).sort()).toEqual(expect.arrayContaining(['clement@inca.re']));
    expect(v.parGroupe.interne + v.parGroupe.externe + v.parGroupe.non_classe).toBeCloseTo(v.global, 6);
    // l'historique n'est dans AUCUNE performance individuelle
    const hist = lignes.filter((l: any) => l.attribution === 'historique');
    const sansHist = ventilerCA((lignes as any).filter((l: any) => l.attribution !== 'historique'));
    expect(v.performancesIndividuelles).toBeCloseTo(sansHist.performancesIndividuelles, 6);
    expect(hist.every((l: any) => l.responsable_email === null)).toBe(true);
    expect(v.parGroupe.non_classe).toBeGreaterThanOrEqual(v.historiqueNonAttribue.ca);   // toutes les commandes historiques sont « non classé »
  });

  test('STATIQUE : aucune suppression ni réécriture de données dans les migrations ; le remplissage ne modifie que orders.client_id ; aucune TVA', () => {
    const code = (s: string) => s.split(/\r?\n/).map(l => l.replace(/--.*$/, '')).join('\n');
    for (const [nom, s] of [['crm_attribution.sql', code(M1)], ['crm_attribution_remplissage.sql', code(REMPLISSAGE)]] as const) {
      expect(s, nom).not.toMatch(/\b(DELETE\s+FROM|TRUNCATE|DROP\s+(TABLE|COLUMN|SCHEMA|VIEW)|ALTER\s+TABLE\s+\w+\s+DROP\s+COLUMN)\b/i);
      expect(s, nom).not.toMatch(/tva(?!_rate)/i);      // le module TVA (en pause) n'est pas concerné ; tva_rate_snapshot = taux figé d'une ligne de commande
    }
    const r = code(REMPLISSAGE);
    expect(r.match(/UPDATE\s+\w+/gi)).toEqual(['UPDATE orders']);
    expect(r).toMatch(/SET client_id = cible\.client_id/);
    expect(r).not.toMatch(/SET\s+(responsable|attribution)/i);      // le remplissage ne touche ni au responsable ni à l'attribution
    expect(r.match(/INSERT\s+INTO/gi)).toBeNull();
    // la structure ne touche aux données existantes d'aucune table (les UPDATE/INSERT ne sont que dans le corps des fonctions)
    const hors = code(M1).replace(/\$(function|\w*)\$[\s\S]*?\$\1\$/g, '').replace(/\$\$[\s\S]*?\$\$/g, '');
    expect(hors).not.toMatch(/\b(UPDATE\s+\w+\s+SET|INSERT\s+INTO)\b/i);
  });
});
