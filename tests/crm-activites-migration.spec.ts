/**
 * CRM M2 — migration crm_activites.sql sur une base LOCALE (PGlite). Aucune connexion à Supabase, aucune écriture en production.
 * La base reproduit la production après la phase 0 et M1 (structure), avec les 6 tâches existantes de weekly_tasks.
 */
import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';

const lire = (f: string) => readFileSync(`supabase/migrations/${f}`, 'utf8');
const M1 = lire('crm_attribution.sql');
const M2 = lire('crm_activites.sql');

const MIGRATIONS_AVANT = [
  'orders_bl_number.sql', 'order_items_price_snapshots.sql', 'order_items_picked_column.sql', 'stock_rpc_functions.sql', 'product_adjust_stock_rpc.sql',
  'product_adjust_stock_fix.sql', 'shipments_table.sql', 'suppliers_table.sql', 'stock_reserve.sql', 'order_update_checked.sql',
  'order_update_checked_price_refresh.sql', 'price_groups.sql', 'suppliers_stable_id_matching.sql', 'dlc_lots.sql', 'products_nouveau.sql',
  'order_create_checked_active_client.sql', 'products_visible_catalogue.sql', 'client_product_access.sql',
  'bl_sequence.sql', 'bl_signatures.sql', 'bl_commandes.sql', 'securite_phase0.sql', 'weekly_tasks_table.sql',
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
const CLEMENT = '22222222-2222-2222-2222-222222222222';   // commercial
const ARNAUD = '33333333-3333-3333-3333-333333333333';    // autre commercial
const MEL: Record<string, string> = { [ADMIN]: 'admin@inca.re', [CLEMENT]: 'clement@inca.re', [ARNAUD]: 'arnaud@inca.re' };
const ROLE: Record<string, string> = { [ADMIN]: 'admin', [CLEMENT]: 'commercial', [ARNAUD]: 'commercial' };

const exec = async (db: PGlite, q: string, p: unknown[] = []) => (await db.query<any>(q, p)).rows;
const un = async (db: PGlite, q: string, p: unknown[] = []) => (await exec(db, q, p))[0];
const as = async (db: PGlite, role: string, q: string, p: unknown[] = []) => {
  await db.exec(`SET ROLE ${role}`);
  try { return { rows: (await db.query<any>(q, p)).rows as any[], error: '' }; }
  catch (e: any) { return { rows: [] as any[], error: String(e.message ?? e) }; }
  finally { await db.exec('RESET ROLE'); }
};
const srv = (db: PGlite, q: string, p: unknown[] = []) => as(db, 'service_role', q, p);
const uuid = () => crypto.randomUUID();
const jour = (n: number) => new Date(Date.now() + n * 86400000 + 4 * 3600000).toISOString().slice(0, 10); // date de La Réunion + n jours

const TACHES = ['Appeler le transporteur', 'Commander des gobelets', 'Vérifier les DLC', 'Relancer le fournisseur', 'Mettre à jour les prix', 'Inventaire frigo'];

async function baseM2(): Promise<{ db: PGlite; ids: Record<string, string> }> {
  const db = new PGlite();
  await db.exec(ENV);
  for (const f of MIGRATIONS_AVANT) { try { await db.exec(lire(f)); } catch (e: any) { throw new Error(`migration ${f} : ${e.message}`); } }
  await db.exec(`REVOKE ALL ON weekly_tasks FROM anon, authenticated`);          // comme en production (phase 0)
  for (let i = 0; i < TACHES.length; i++) await db.query(`INSERT INTO weekly_tasks (content, done, done_at) VALUES ($1, $2, $3)`, [TACHES[i], i === 5, i === 5 ? '2026-10-01T10:00:00Z' : null]);
  await db.exec(M1);
  // Droits par défaut rouverts AVANT M2 : ainsi les REVOKE explicites de M2 sont réellement vérifiés (et pas seulement ceux de la phase 0)
  await db.exec(`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated; ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;`);
  const cl = async (nom: string, email: string, statut = 'actif') => (await un(db, `INSERT INTO client_accounts (nom, societe, email, status) VALUES ($1, $1, $2, $3) RETURNING id`, [nom, email, statut])).id;
  const ids: Record<string, string> = { clem: await cl('Client de Clément', 'c@x.fr'), arn: await cl('Client d\'Arnaud', 'a@x.fr'), libre: await cl('Client libre', 'l@x.fr'), prospect: await cl('Prospect', 'p@x.fr', 'prospect') };
  const att = (c: string, r: string) => srv(db, `SELECT client_attribuer($1, $2, $3, 'attribution', $4, $5, 'admin', NULL)`, [c, r, MEL[r], ADMIN, MEL[ADMIN]]);
  expect((await att(ids.clem, CLEMENT)).error).toBe('');
  expect((await att(ids.arn, ARNAUD)).error).toBe('');
  expect((await att(ids.prospect, CLEMENT)).error).toBe('');
  return { db, ids };
}

type Noter = Partial<{ cle: string; client: string; type: string; resultat: string | null; commentaire: string | null; action: string | null; quand: string | null;
  relance: string | null; echeance: string | null; heure: string | null; titre: string | null; assigne: string | null; assigneMel: string | null; acteur: string }>;
const noter = (db: PGlite, o: Noter = {}) => {
  const acteur = o.acteur ?? CLEMENT;
  return srv(db, `SELECT interaction_noter($1::uuid, $2::uuid, $3, $4, $5, $6, $7::timestamptz, $8::uuid, $9::date, $10::time, $11, $12::uuid, $13, $14::uuid, $15, $16) AS r`,
    [o.cle ?? uuid(), o.client, o.type ?? 'appel', o.resultat === undefined ? 'echange' : o.resultat, o.commentaire ?? null, o.action ?? null, o.quand ?? null,
      o.relance ?? null, o.echeance ?? null, o.heure ?? null, o.titre ?? null, o.assigne ?? null, o.assigneMel ?? null, acteur, MEL[acteur], ROLE[acteur]]);
};
const programmer = (db: PGlite, client: string, o: Partial<{ cle: string; titre: string; echeance: string; heure: string | null; assigne: string | null; acteur: string }> = {}) => {
  const acteur = o.acteur ?? CLEMENT;
  return srv(db, `SELECT relance_programmer($1::uuid, $2::uuid, $3, $4::date, $5::time, $6::uuid, $7, $8::uuid, $9, $10) AS r`,
    [o.cle ?? uuid(), client, o.titre ?? 'Rappeler', o.echeance ?? jour(3), o.heure ?? null, o.assigne ?? null, o.assigne ? MEL[o.assigne] : null, acteur, MEL[acteur], ROLE[acteur]]);
};
const rpc = (db: PGlite, nom: string, args: unknown[], types: string[]) =>
  srv(db, `SELECT ${nom}(${args.map((_, i) => `$${i + 1}::${types[i]}`).join(', ')}) AS r`, args);
const acteurArgs = (a: string) => [a, MEL[a], ROLE[a]];

const ERR = (e: string, code: string) => expect(e).toContain(code);

test.describe.serial('CRM M2 — activités, relances, délégations (base locale)', () => {
  let db: PGlite; let ids: Record<string, string>; let tachesAvant: any[]; let ordersAvant: any[];

  test.beforeAll(async () => {
    ({ db, ids } = await baseM2());
    tachesAvant = await exec(db, `SELECT id, content, done, created_at, done_at FROM weekly_tasks ORDER BY content`);
    ordersAvant = await exec(db, `SELECT * FROM orders ORDER BY id`);
    await db.exec(M2);
  });
  test.afterAll(async () => { await db.close(); });

  test('préservation : les 6 tâches existantes sont identiques, deviennent des tâches générales, statut calculé ; rejouable', async () => {
    const lues = async () => exec(db, `SELECT id, content, done, created_at, done_at FROM weekly_tasks ORDER BY content`);
    expect(await lues()).toEqual(tachesAvant);
    expect(tachesAvant).toHaveLength(6);
    const n = await exec(db, `SELECT type, client_id, assigne_a, echeance, reports, statut, count(*)::int n FROM weekly_tasks GROUP BY 1,2,3,4,5,6 ORDER BY statut`);
    expect(n).toEqual([{ type: 'tache', client_id: null, assigne_a: null, echeance: null, reports: 0, statut: 'a_faire', n: 5 }, { type: 'tache', client_id: null, assigne_a: null, echeance: null, reports: 0, statut: 'faite', n: 1 }]);
    await db.exec(M2);                                                                   // rejeu : aucune erreur, aucun changement
    expect(await lues()).toEqual(tachesAvant);
    expect((await un(db, `SELECT count(*)::int n FROM client_interactions`)).n).toBe(0);
  });

  test('les tâches générales se comportent comme avant (ajout, case à cocher, décoche) ; type relance impossible à la main', async () => {
    expect((await srv(db, `INSERT INTO weekly_tasks (content) VALUES ('Nouvelle tâche')`)).error).toBe('');
    expect((await srv(db, `UPDATE weekly_tasks SET done = true, done_at = now() WHERE content = 'Nouvelle tâche'`)).error).toBe('');
    expect((await srv(db, `UPDATE weekly_tasks SET done = false, done_at = NULL WHERE content = 'Nouvelle tâche'`)).error).toBe('');
    ERR((await srv(db, `INSERT INTO weekly_tasks (content, type) VALUES ('x', 'relance')`)).error, 'weekly_tasks_relance_complete');
    ERR((await srv(db, `UPDATE weekly_tasks SET type = 'relance' WHERE content = 'Nouvelle tâche'`)).error, 'RELANCE_PROTEGEE');
    ERR((await srv(db, `UPDATE weekly_tasks SET assigne_a = '${CLEMENT}' WHERE content = 'Nouvelle tâche'`)).error, 'RELANCE_PROTEGEE');
    expect((await srv(db, `DELETE FROM weekly_tasks WHERE content = 'Nouvelle tâche'`)).error).toBe('');
  });

  test('fermeture : RLS actif, rien pour anon/authenticated, search_path figé, exécution réservée à service_role', async () => {
    for (const t of ['client_interactions', 'client_contacts', 'crm_delegations', 'crm_suggestions_masquees']) {
      expect((await un(db, `SELECT relrowsecurity r FROM pg_class WHERE relname = $1`, [t])).r).toBe(true);
      for (const r of ['anon', 'authenticated']) expect((await un(db, `SELECT has_table_privilege('${r}', '${t}', 'SELECT,INSERT,UPDATE,DELETE') a`)).a).toBe(false);
    }
    const fonctions = await exec(db, `SELECT p.oid::regprocedure::text sig, p.proconfig, p.prosecdef FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND (p.proname LIKE 'interaction\\_%' OR p.proname LIKE 'relance\\_%' OR p.proname LIKE 'contact\\_%' OR p.proname LIKE 'delegation\\_%'
        OR p.proname LIKE 'suggestion\\_%' OR p.proname LIKE 'crm\\_%' OR p.proname IN ('client_interactions_proteger', 'weekly_tasks_proteger'))`);
    expect(fonctions.length).toBeGreaterThanOrEqual(20);
    for (const f of fonctions) {
      expect(JSON.stringify(f.proconfig), f.sig).toContain('search_path=public, pg_temp');
      expect(f.prosecdef, f.sig).toBe(false);
      for (const r of ['anon', 'authenticated']) expect((await un(db, `SELECT has_function_privilege('${r}', '${f.sig}', 'EXECUTE') a`)).a, `${r} ${f.sig}`).toBe(false);
    }
    expect((await as(db, 'anon', `SELECT crm_aujourdhui()`)).error).toContain('permission denied');
    expect((await as(db, 'authenticated', `SELECT interaction_noter(gen_random_uuid(), gen_random_uuid(), 'appel', 'echange', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, gen_random_uuid(), 'x@x.fr', 'admin')`)).error).toContain('permission denied');
  });

  test('droits : administrateur partout ; commercial seulement sur son portefeuille ; client libre ou inexistant refusé', async () => {
    const peut = async (c: string, a: string) => (await un(db, `SELECT crm_peut_agir($1::uuid, $2::uuid, $3) p`, [c, a, ROLE[a]])).p;
    expect(await peut(ids.clem, ADMIN)).toBe(true);
    expect(await peut(ids.libre, ADMIN)).toBe(true);
    expect(await peut(ids.clem, CLEMENT)).toBe(true);
    expect(await peut(ids.prospect, CLEMENT)).toBe(true);
    expect(await peut(ids.arn, CLEMENT)).toBe(false);
    expect(await peut(ids.libre, CLEMENT)).toBe(false);
    expect(await peut(uuid(), ADMIN)).toBe(false);
    expect((await un(db, `SELECT crm_peut_agir($1::uuid, $2::uuid, 'inconnu') p`, [ids.clem, CLEMENT])).p).toBe(false);
    expect((await un(db, `SELECT crm_peut_agir($1::uuid, $2::uuid, 'client') p`, [ids.clem, CLEMENT])).p).toBe(false);
  });

  test('noter un appel : activité + relance en une transaction ; commentaire facultatif ; rendez-vous si heure', async () => {
    const r = await noter(db, { client: ids.clem, resultat: 'echange', action: 'rappeler', echeance: jour(3) });
    expect(r.error).toBe('');
    const j = r.rows[0].r; expect(j.deja).toBe(false); expect(j.interaction_id).toBeTruthy(); expect(j.relance_id).toBeTruthy();
    const i = await un(db, `SELECT * FROM client_interactions WHERE id = $1`, [j.interaction_id]);
    expect(i).toMatchObject({ type: 'appel', resultat: 'echange', commentaire: null, prochaine_action: 'rappeler', client_libelle: 'Client de Clément', created_by: CLEMENT, nb_modifications: 0 });
    const t = await un(db, `SELECT * FROM weekly_tasks WHERE id = $1`, [j.relance_id]);
    expect(t).toMatchObject({ type: 'relance', content: 'Rappeler', assigne_a: CLEMENT, assigne_email: MEL[CLEMENT], statut: 'a_faire', reports: 0, client_id: ids.clem });
    expect(String(t.echeance.toISOString?.().slice(0, 10) ?? t.echeance)).toBe(jour(3));
    const rv = await noter(db, { client: ids.clem, resultat: 'rdv_pris', action: 'visiter', echeance: jour(5), heure: '10:30', titre: 'Visite du magasin' });
    expect((await un(db, `SELECT type, content, heure::text h FROM weekly_tasks WHERE id = $1`, [rv.rows[0].r.relance_id]))).toEqual({ type: 'rendez_vous', content: 'Visite du magasin', h: '10:30:00' });
    const sans = await noter(db, { client: ids.clem, resultat: 'pas_de_reponse' });
    expect(sans.rows[0].r.relance_id).toBeNull();
  });

  test('rejeu (double appui) : même clé = même résultat, aucun doublon ; la clé d\'un autre utilisateur est refusée', async () => {
    const cle = uuid();
    const a = await noter(db, { cle, client: ids.clem, action: 'rappeler', echeance: jour(2) });
    const b = await noter(db, { cle, client: ids.clem, action: 'rappeler', echeance: jour(2) });
    expect(b.error).toBe('');
    expect(b.rows[0].r).toMatchObject({ deja: true, interaction_id: a.rows[0].r.interaction_id, relance_id: a.rows[0].r.relance_id });
    expect((await un(db, `SELECT count(*)::int n FROM client_interactions WHERE cle_idempotence = $1`, [cle])).n).toBe(1);
    expect((await un(db, `SELECT count(*)::int n FROM weekly_tasks WHERE cle_idempotence = $1`, [cle])).n).toBe(1);
    ERR((await noter(db, { cle, client: ids.arn, acteur: ARNAUD })).error, 'CLE_DEJA_UTILISEE');
    const p = uuid(); const p1 = await programmer(db, ids.clem, { cle: p }); const p2 = await programmer(db, ids.clem, { cle: p });
    expect(p2.rows[0].r).toMatchObject({ deja: true, relance_id: p1.rows[0].r.relance_id });
  });

  test('validations : résultat requis (appel/visite), précision pour « Autre » et pour une note, taille, date, type, action, échéance', async () => {
    const c = ids.clem;
    ERR((await noter(db, { client: c, resultat: null })).error, 'RESULTAT_REQUIS');
    ERR((await noter(db, { client: c, type: 'visite', resultat: null })).error, 'RESULTAT_REQUIS');
    ERR((await noter(db, { client: c, resultat: 'autre' })).error, 'COMMENTAIRE_REQUIS');
    ERR((await noter(db, { client: c, resultat: 'autre', commentaire: '  ab ' })).error, 'COMMENTAIRE_REQUIS');
    expect((await noter(db, { client: c, resultat: 'autre', commentaire: 'Veut un devis' })).error).toBe('');
    ERR((await noter(db, { client: c, type: 'note', resultat: null })).error, 'COMMENTAIRE_REQUIS');
    expect((await noter(db, { client: c, type: 'note', resultat: null, commentaire: 'Gérant absent jusqu\'à lundi' })).error).toBe('');
    ERR((await noter(db, { client: c, commentaire: 'x'.repeat(2001) })).error, 'COMMENTAIRE_TROP_LONG');
    ERR((await noter(db, { client: c, resultat: 'bizarre' })).error, 'RESULTAT_INVALIDE');
    ERR((await noter(db, { client: c, type: 'sms' })).error, 'TYPE_INVALIDE');
    ERR((await noter(db, { client: c, action: 'danser' })).error, 'ACTION_INVALIDE');
    ERR((await noter(db, { client: c, quand: new Date(Date.now() + 3600e3).toISOString() })).error, 'DATE_INVALIDE');
    ERR((await noter(db, { client: c, quand: new Date(Date.now() - 40 * 86400e3).toISOString() })).error, 'DATE_INVALIDE');
    ERR((await noter(db, { client: c, action: 'rappeler' })).error, 'ECHEANCE_REQUISE');
    ERR((await noter(db, { client: c, action: 'rappeler', echeance: jour(-1) })).error, 'ECHEANCE_INVALIDE');
    ERR((await noter(db, { client: c, action: 'rappeler', echeance: jour(400) })).error, 'ECHEANCE_INVALIDE');
    ERR((await noter(db, { client: c, action: 'aucune', echeance: jour(2) })).error, 'ACTION_INCOHERENTE');
    expect((await noter(db, { client: c, action: 'aucune' })).error).toBe('');
    ERR((await noter(db, { client: uuid() })).error, 'CLIENT_INTROUVABLE');
    ERR((await noter(db, { client: c, cle: undefined as any, acteur: 'pas-un-uuid' as any })).error, 'invalid input syntax');
    ERR((await srv(db, `SELECT interaction_noter(NULL, $1::uuid, 'appel', 'echange', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, $2::uuid, $3, 'admin')`, [c, CLEMENT, MEL[CLEMENT]])).error, 'CLE_REQUISE');
    ERR((await srv(db, `SELECT interaction_noter(gen_random_uuid(), $1::uuid, 'appel', 'echange', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, $2::uuid, $3, 'client')`, [c, CLEMENT, MEL[CLEMENT]])).error, 'ACTEUR_INVALIDE');
    ERR((await srv(db, `SELECT interaction_noter(gen_random_uuid(), $1::uuid, 'appel', 'echange', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, $2, 'admin')`, [c, MEL[CLEMENT]])).error, 'ACTEUR_INVALIDE');
  });

  test('un commercial ne peut pas agir hors de son portefeuille ; rien n\'est écrit lors d\'un refus', async () => {
    const avant = await un(db, `SELECT (SELECT count(*) FROM client_interactions)::int i, (SELECT count(*) FROM weekly_tasks)::int t`);
    ERR((await noter(db, { client: ids.clem, action: 'rappeler', echeance: jour(2), assigne: ARNAUD, assigneMel: MEL[ARNAUD] })).error, 'ACTION_INTERDITE');   // un commercial ne confie pas une relance à un autre
    ERR((await noter(db, { client: ids.arn })).error, 'ACTION_INTERDITE');
    ERR((await noter(db, { client: ids.libre, action: 'rappeler', echeance: jour(2) })).error, 'ACTION_INTERDITE');
    ERR((await programmer(db, ids.arn)).error, 'ACTION_INTERDITE');
    ERR((await rpc(db, 'contact_enregistrer', [null, ids.arn, 'Mme X', null, null, null, false, null, ...acteurArgs(CLEMENT)], ['uuid', 'uuid', 'text', 'text', 'text', 'text', 'boolean', 'text', 'uuid', 'text', 'text'])).error, 'ACTION_INTERDITE');
    expect(await un(db, `SELECT (SELECT count(*) FROM client_interactions)::int i, (SELECT count(*) FROM weekly_tasks)::int t`)).toEqual(avant);
    expect((await noter(db, { client: ids.clem, action: 'rappeler', echeance: jour(2), assigne: ARNAUD, assigneMel: MEL[ARNAUD], acteur: ADMIN })).error).toBe('');
    expect((await noter(db, { client: ids.arn, acteur: ADMIN })).error).toBe('');       // l'administrateur agit partout
    expect((await noter(db, { client: ids.libre, acteur: ADMIN })).error).toBe('');
  });

  test('délégation : l\'administrateur ouvre le portefeuille d\'un autre commercial ; refus sans, après révocation, après expiration', async () => {
    const T = ['uuid', 'text', 'uuid', 'text', 'date', 'text', 'uuid', 'text', 'text'];
    const accorder = (a: string, exp: string | null = null, motif = 'Congés d\'Arnaud', acteur = ADMIN, com = CLEMENT, prop = ARNAUD) =>
      rpc(db, 'delegation_accorder', [com, MEL[com], prop, MEL[prop], exp, motif, ...acteurArgs(acteur)], T);
    ERR((await accorder('x', null, 'Congés', CLEMENT)).error, 'ACTION_INTERDITE');            // un commercial ne s'accorde rien
    ERR((await accorder('x', null, 'ab')).error, 'MOTIF_REQUIS');
    ERR((await accorder('x', jour(-1))).error, 'ECHEANCE_INVALIDE');
    ERR((await rpc(db, 'delegation_accorder', [CLEMENT, MEL[CLEMENT], CLEMENT, MEL[CLEMENT], null, 'Congés', ...acteurArgs(ADMIN)], T)).error, 'AUCUN_CHANGEMENT');
    const ok = await accorder('x'); expect(ok.error).toBe('');
    ERR((await accorder('x')).error, 'DELEGATION_EXISTANTE');
    expect((await noter(db, { client: ids.arn, resultat: 'echange', action: 'rappeler', echeance: jour(2) })).error).toBe('');   // Clément agit sur le client d'Arnaud
    expect((await noter(db, { client: ids.libre })).error).not.toBe('');                      // mais pas sur un client libre
    expect((await un(db, `SELECT count(*)::int n FROM admin_audit_logs WHERE action = 'crm.delegation_accordee'`)).n).toBe(1);
    // la délégation n'est pas réciproque
    ERR((await noter(db, { client: ids.clem, acteur: ARNAUD })).error, 'ACTION_INTERDITE');
    ERR((await rpc(db, 'delegation_revoquer', [ok.rows[0].r.delegation_id, 'Retour', ...acteurArgs(CLEMENT)], ['uuid', 'text', 'uuid', 'text', 'text'])).error, 'ACTION_INTERDITE');
    ERR((await rpc(db, 'delegation_revoquer', [ok.rows[0].r.delegation_id, 'x', ...acteurArgs(ADMIN)], ['uuid', 'text', 'uuid', 'text', 'text'])).error, 'MOTIF_REQUIS');
    expect((await rpc(db, 'delegation_revoquer', [ok.rows[0].r.delegation_id, 'Retour de congés', ...acteurArgs(ADMIN)], ['uuid', 'text', 'uuid', 'text', 'text'])).error).toBe('');
    ERR((await noter(db, { client: ids.arn })).error, 'ACTION_INTERDITE');
    ERR((await rpc(db, 'delegation_revoquer', [ok.rows[0].r.delegation_id, 'Encore', ...acteurArgs(ADMIN)], ['uuid', 'text', 'uuid', 'text', 'text'])).error, 'DELEGATION_DEJA_REVOQUEE');
    // expirée : on antidate l'expiration par le réglage réservé aux fonctions (jamais possible par l'application)
    const exp = await accorder('x', jour(1)); expect(exp.error).toBe('');
    await db.exec(`ALTER TABLE crm_delegations DISABLE TRIGGER trg_crm_delegations_proteger; UPDATE crm_delegations SET expire_le = current_date - 400 WHERE revoque_le IS NULL; ALTER TABLE crm_delegations ENABLE TRIGGER trg_crm_delegations_proteger;`);
    ERR((await noter(db, { client: ids.arn })).error, 'ACTION_INTERDITE');
    expect((await un(db, `SELECT count(*)::int n FROM admin_audit_logs WHERE action = 'crm.delegation_revoquee'`)).n).toBe(1);
  });

  test('délégations non supprimables ni modifiables à la main', async () => {
    ERR((await srv(db, `DELETE FROM crm_delegations`)).error, 'DELEGATION_NON_SUPPRIMABLE');
    ERR((await srv(db, `TRUNCATE crm_delegations`)).error, 'DELEGATION_NON_SUPPRIMABLE');
    ERR((await srv(db, `UPDATE crm_delegations SET revoque_le = now(), revoque_par = 'x', revocation_motif = 'xxx'`)).error, 'DELEGATION_PROTEGEE');
  });

  test('une relance programmée n\'est JAMAIS fermée par un autre échange ; seule la demande explicite la ferme', async () => {
    const r = await programmer(db, ids.clem, { titre: 'Rappeler pour l\'offre', echeance: jour(4) });
    const rel = r.rows[0].r.relance_id;
    for (const o of [{ resultat: 'echange' }, { resultat: 'pas_de_reponse' }, { type: 'visite', resultat: 'commande_envisagee' }, { type: 'note', resultat: null, commentaire: 'note libre' }])
      expect((await noter(db, { client: ids.clem, ...o })).error).toBe('');
    expect(await un(db, `SELECT statut, done, annulee_le FROM weekly_tasks WHERE id = $1`, [rel])).toEqual({ statut: 'a_faire', done: false, annulee_le: null });
    // une nouvelle relance programmée en notant un échange n'écrase pas l'ancienne
    expect((await noter(db, { client: ids.clem, action: 'visiter', echeance: jour(6) })).error).toBe('');
    expect((await un(db, `SELECT count(*)::int n FROM weekly_tasks WHERE client_id = $1 AND statut = 'a_faire' AND type <> 'tache' AND id = $2`, [ids.clem, rel])).n).toBe(1);
    // clôture explicite par l'échange
    const c = await noter(db, { client: ids.clem, relance: rel, resultat: 'echange' });
    expect(c.error).toBe('');
    expect(c.rows[0].r.relance_fermee_id).toBe(rel);
    expect(await un(db, `SELECT statut, interaction_id IS NOT NULL lie FROM weekly_tasks WHERE id = $1`, [rel])).toEqual({ statut: 'faite', lie: true });
    ERR((await noter(db, { client: ids.clem, relance: rel })).error, 'RELANCE_DEJA_TRAITEE');
    const autre = (await programmer(db, ids.prospect)).rows[0].r.relance_id;
    ERR((await noter(db, { client: ids.clem, relance: autre })).error, 'RELANCE_AUTRE_CLIENT');
    const tache = (await un(db, `SELECT id FROM weekly_tasks WHERE type = 'tache' LIMIT 1`)).id;
    ERR((await noter(db, { client: ids.clem, relance: tache })).error, 'RELANCE_INTROUVABLE');
    ERR((await noter(db, { client: ids.clem, relance: uuid() })).error, 'RELANCE_INTROUVABLE');
  });

  test('relance : responsable, échéance, report compté et journalisé, clôture, annulation motivée, réassignation par l\'administrateur', async () => {
    const mk = async (c = ids.clem, a = CLEMENT) => (await programmer(db, c, { acteur: a, echeance: jour(2) })).rows[0].r.relance_id as string;
    const rel = await mk();
    const reporter = (id: string, ech: string, a = CLEMENT, motif: string | null = 'Client en déplacement') => rpc(db, 'relance_reporter', [id, ech, motif, ...acteurArgs(a)], ['uuid', 'date', 'text', 'uuid', 'text', 'text']);
    ERR((await reporter(rel, jour(-1))).error, 'ECHEANCE_INVALIDE');
    ERR((await reporter(rel, jour(2))).error, 'AUCUN_CHANGEMENT');
    ERR((await reporter(rel, jour(5), ARNAUD)).error, 'ACTION_INTERDITE');
    expect((await reporter(rel, jour(5))).rows[0].r).toMatchObject({ reports: 1 });
    expect((await reporter(rel, jour(9), ADMIN)).rows[0].r).toMatchObject({ reports: 2 });
    const t = await un(db, `SELECT echeance::text e, echeance_initiale::text i, reports FROM weekly_tasks WHERE id = $1`, [rel]);
    expect(t).toEqual({ e: jour(9), i: jour(2), reports: 2 });
    const log = await exec(db, `SELECT details FROM admin_audit_logs WHERE action = 'relance.report' AND target_id = $1 ORDER BY created_at`, [rel]);
    expect(log).toHaveLength(2); expect(log[0].details).toMatchObject({ ancienne_echeance: jour(2), nouvelle_echeance: jour(5), motif: 'Client en déplacement' });
    const clore = (id: string, st: string, motif: string | null, a = CLEMENT) => rpc(db, 'relance_cloturer', [id, st, motif, ...acteurArgs(a)], ['uuid', 'text', 'text', 'uuid', 'text', 'text']);
    ERR((await clore(rel, 'annulee', null)).error, 'MOTIF_REQUIS');
    ERR((await clore(rel, 'peut-etre', 'abc')).error, 'STATUT_INVALIDE');
    ERR((await clore(rel, 'faite', null, ARNAUD)).error, 'ACTION_INTERDITE');
    expect((await clore(rel, 'annulee', 'Client parti à la concurrence')).error).toBe('');
    expect(await un(db, `SELECT statut, annulation_motif m FROM weekly_tasks WHERE id = $1`, [rel])).toEqual({ statut: 'annulee', m: 'Client parti à la concurrence' });
    ERR((await reporter(rel, jour(20))).error, 'RELANCE_DEJA_TRAITEE');
    ERR((await clore(rel, 'faite', null)).error, 'RELANCE_DEJA_TRAITEE');
    const r2 = await mk(); expect((await clore(r2, 'faite', null)).error).toBe('');
    expect((await un(db, `SELECT statut FROM weekly_tasks WHERE id = $1`, [r2])).statut).toBe('faite');
    const r3 = await mk();
    const reass = (id: string, nv: string, motif: string | null, a = ADMIN) => rpc(db, 'relance_reassigner', [id, nv, MEL[nv], motif, ...acteurArgs(a)], ['uuid', 'uuid', 'text', 'text', 'uuid', 'text', 'text']);
    ERR((await reass(r3, ARNAUD, 'Congés', CLEMENT)).error, 'ACTION_INTERDITE');
    ERR((await reass(r3, ARNAUD, null)).error, 'MOTIF_REQUIS');
    ERR((await reass(r3, CLEMENT, 'Congés')).error, 'AUCUN_CHANGEMENT');
    expect((await reass(r3, ARNAUD, 'Congés de Clément')).error).toBe('');
    expect((await un(db, `SELECT assigne_a FROM weekly_tasks WHERE id = $1`, [r3])).assigne_a).toBe(ARNAUD);
    expect((await un(db, `SELECT count(*)::int n FROM admin_audit_logs WHERE action = 'relance.reassignation' AND target_id = $1`, [r3])).n).toBe(1);
    // un commercial ne peut pas confier une relance à quelqu'un d'autre ; l'administrateur le peut
    ERR((await programmer(db, ids.clem, { assigne: ARNAUD })).error, 'ACTION_INTERDITE');
    expect((await programmer(db, ids.clem, { assigne: ARNAUD, acteur: ADMIN })).error).toBe('');
    ERR((await programmer(db, ids.clem, { echeance: jour(-2) })).error, 'ECHEANCE_INVALIDE');
  });

  test('relances et activités : jamais supprimées, jamais modifiées à la main', async () => {
    const rel = (await programmer(db, ids.clem)).rows[0].r.relance_id;
    ERR((await srv(db, `DELETE FROM weekly_tasks WHERE id = $1`, [rel])).error, 'RELANCE_NON_SUPPRIMABLE');
    ERR((await srv(db, `UPDATE weekly_tasks SET echeance = current_date + 30 WHERE id = $1`, [rel])).error, 'RELANCE_PROTEGEE');
    ERR((await srv(db, `UPDATE weekly_tasks SET done = true WHERE id = $1`, [rel])).error, 'RELANCE_PROTEGEE');
    ERR((await srv(db, `UPDATE weekly_tasks SET assigne_a = '${ARNAUD}' WHERE id = $1`, [rel])).error, 'RELANCE_PROTEGEE');
    ERR((await srv(db, `UPDATE weekly_tasks SET type = 'tache' WHERE id = $1`, [rel])).error, 'RELANCE_PROTEGEE');
    ERR((await srv(db, `DELETE FROM client_interactions`)).error, 'INTERACTION_NON_SUPPRIMABLE');
    ERR((await srv(db, `TRUNCATE client_interactions CASCADE`)).error, 'NON_SUPPRIMABLE');
    ERR((await srv(db, `TRUNCATE weekly_tasks`)).error, 'RELANCE_NON_SUPPRIMABLE');
    ERR((await srv(db, `TRUNCATE weekly_tasks CASCADE`)).error, 'NON_SUPPRIMABLE');
    ERR((await srv(db, `UPDATE client_interactions SET commentaire = 'réécrit'`)).error, 'INTERACTION_PROTEGEE');
    ERR((await srv(db, `UPDATE client_interactions SET annulee_le = now(), annulee_par = 'x', annulation_motif = 'xxx'`)).error, 'INTERACTION_PROTEGEE');
    // même avec le réglage interne, les colonnes d'origine restent immuables
    const imm = await srv(db, `SELECT set_config('inca.crm_ecriture', '1', false)`); expect(imm.error).toBe('');
    for (const col of ["type = 'visite'", "occurred_at = now() - interval '1 day'", `created_by = '${ARNAUD}'`, "created_by_email = 'x@x.fr'", "client_libelle = 'Autre'", `client_id = '${ids.arn}'`, 'cle_idempotence = gen_random_uuid()'])
      ERR((await srv(db, `UPDATE client_interactions SET ${col}`)).error, 'INTERACTION_IMMUABLE');
    ERR((await srv(db, `UPDATE weekly_tasks SET client_id = '${ids.arn}' WHERE id = $1`, [rel])).error, 'RELANCE_IMMUABLE');
    ERR((await srv(db, `UPDATE weekly_tasks SET type = 'tache' WHERE id = $1`, [rel])).error, 'RELANCE_IMMUABLE');
    await srv(db, `SELECT set_config('inca.crm_ecriture', '', false)`);
  });

  test('correction : l\'auteur sous 24 h, passé ce délai l\'administrateur avec motif ; ancien et nouveau contenu journalisés ; annulation motivée', async () => {
    const i = (await noter(db, { client: ids.clem, resultat: 'echange', commentaire: 'Premier avis' })).rows[0].r.interaction_id as string;
    const corr = (id: string, res: string | null, com: string | null, act: string | null, motif: string | null, a = CLEMENT) =>
      rpc(db, 'interaction_corriger', [id, res, com, act, motif, ...acteurArgs(a)], ['uuid', 'text', 'text', 'text', 'text', 'uuid', 'text', 'text']);
    ERR((await corr(i, 'echange', 'Premier avis', null, null)).error, 'AUCUN_CHANGEMENT');
    ERR((await corr(i, 'echange', 'Avis', null, null, ARNAUD)).error, 'ACTION_INTERDITE');
    ERR((await corr(i, null, 'Avis', null, null)).error, 'RESULTAT_REQUIS');
    ERR((await corr(i, 'autre', null, null, null)).error, 'COMMENTAIRE_REQUIS');
    ERR((await corr(i, 'nimporte', null, null, null)).error, 'RESULTAT_INVALIDE');
    expect((await corr(i, 'commande_envisagee', 'Corrigé : veut commander', 'preparer_commande', null)).error).toBe('');
    expect(await un(db, `SELECT resultat, commentaire, prochaine_action, nb_modifications, modifiee_le IS NOT NULL m FROM client_interactions WHERE id = $1`, [i]))
      .toEqual({ resultat: 'commande_envisagee', commentaire: 'Corrigé : veut commander', prochaine_action: 'preparer_commande', nb_modifications: 1, m: true });
    const log = await un(db, `SELECT admin_email, details FROM admin_audit_logs WHERE action = 'interaction.correction' AND target_id = $1`, [i]);
    expect(log.admin_email).toBe(MEL[CLEMENT]);
    expect(log.details.ancien).toEqual({ resultat: 'echange', commentaire: 'Premier avis', prochaine_action: null });
    expect(log.details.nouveau).toMatchObject({ resultat: 'commande_envisagee', commentaire: 'Corrigé : veut commander' });
    // passé 24 h : l'auteur n'a plus la main, l'administrateur oui, avec motif
    await db.exec(`ALTER TABLE client_interactions DISABLE TRIGGER trg_client_interactions_proteger; UPDATE client_interactions SET created_at = now() - interval '2 days' WHERE id = '${i}'; ALTER TABLE client_interactions ENABLE TRIGGER trg_client_interactions_proteger;`);
    ERR((await corr(i, 'echange', 'Trop tard', null, null)).error, 'DELAI_DEPASSE');
    ERR((await corr(i, 'echange', 'Correction admin', null, null, ADMIN)).error, 'MOTIF_REQUIS');
    expect((await corr(i, 'echange', 'Correction admin', null, 'Erreur de saisie signalée', ADMIN)).error).toBe('');
    expect((await un(db, `SELECT nb_modifications n FROM client_interactions WHERE id = $1`, [i])).n).toBe(2);
    expect((await exec(db, `SELECT details FROM admin_audit_logs WHERE action = 'interaction.correction' AND target_id = $1`, [i])).filter(l => l.details.hors_delai)).toHaveLength(1);
    // annulation
    const annul = (id: string, motif: string | null, a = CLEMENT) => rpc(db, 'interaction_annuler', [id, motif, ...acteurArgs(a)], ['uuid', 'text', 'uuid', 'text', 'text']);
    ERR((await annul(i, null, ADMIN)).error, 'MOTIF_REQUIS');
    ERR((await annul(i, 'Doublon')).error, 'DELAI_DEPASSE');
    expect((await annul(i, 'Saisie en double', ADMIN)).error).toBe('');
    expect(await un(db, `SELECT annulee_par, annulation_motif m FROM client_interactions WHERE id = $1`, [i])).toEqual({ annulee_par: MEL[ADMIN], m: 'Saisie en double' });
    expect(await un(db, `SELECT count(*)::int n FROM client_interactions WHERE id = $1`, [i])).toEqual({ n: 1 });   // toujours là
    ERR((await annul(i, 'Encore', ADMIN)).error, 'INTERACTION_ANNULEE');
    ERR((await corr(i, 'echange', 'X', null, 'motif', ADMIN)).error, 'INTERACTION_ANNULEE');
    const j = (await noter(db, { client: ids.clem })).rows[0].r.interaction_id;
    ERR((await annul(j, 'Doublon', ARNAUD)).error, 'ACTION_INTERDITE');
    expect((await annul(j, 'Mauvais client')).error).toBe('');                         // l'auteur, sous 24 h
    ERR((await annul(uuid(), 'Doublon')).error, 'INTERACTION_INTROUVABLE');
    expect((await un(db, `SELECT count(*)::int n FROM admin_audit_logs WHERE action = 'interaction.annulation'`)).n).toBe(2);
  });

  test('« commande envisagée » n\'est jamais une commande : aucune écriture dans orders ni order_items', async () => {
    const avant = await un(db, `SELECT (SELECT count(*) FROM orders)::int o, (SELECT count(*) FROM order_items)::int i`);
    expect((await noter(db, { client: ids.clem, resultat: 'commande_envisagee', action: 'preparer_commande', echeance: jour(2) })).error).toBe('');
    expect(await un(db, `SELECT (SELECT count(*) FROM orders)::int o, (SELECT count(*) FROM order_items)::int i`)).toEqual(avant);
    expect(await exec(db, `SELECT * FROM orders ORDER BY id`)).toEqual(ordersAvant);
    const corps = M2.replace(/--[^\n]*/g, '');
    expect(corps).not.toMatch(/(INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+(orders|order_items|products|stock_)/i);
  });

  test('interlocuteurs : ajout, principal unique, modification, suppression journalisée, droits', async () => {
    const T = ['uuid', 'uuid', 'text', 'text', 'text', 'text', 'boolean', 'text', 'uuid', 'text', 'text'];
    const sauver = (id: string | null, c: string, nom: string, principal = false, a = CLEMENT) => rpc(db, 'contact_enregistrer', [id, c, nom, 'Gérante', '0692 00 00 00', 'Mme@X.fr', principal, 'note', ...acteurArgs(a)], T);
    const a = await sauver(null, ids.clem, 'Mme Dupont', true); expect(a.error).toBe('');
    const b = await sauver(null, ids.clem, 'M. Martin', true); expect(b.error).toBe('');
    expect((await exec(db, `SELECT nom FROM client_contacts WHERE client_id = $1 AND principal`, [ids.clem]))).toEqual([{ nom: 'M. Martin' }]);
    expect((await sauver(a.rows[0].r.contact_id, ids.clem, 'Mme Dupont-Lebon')).error).toBe('');
    expect(await un(db, `SELECT nom, email, modifie_le IS NOT NULL m FROM client_contacts WHERE id = $1`, [a.rows[0].r.contact_id])).toEqual({ nom: 'Mme Dupont-Lebon', email: 'mme@x.fr', m: true });
    ERR((await sauver(null, ids.clem, ' ')).error, 'NOM_INVALIDE');
    ERR((await sauver(null, uuid(), 'Mme Y')).error, 'CLIENT_INTROUVABLE');
    ERR((await sauver(null, ids.arn, 'Mme Y')).error, 'ACTION_INTERDITE');
    ERR((await sauver(a.rows[0].r.contact_id, ids.arn, 'Mme Y', false, ARNAUD)).error, 'ACTION_INTERDITE');
    ERR((await sauver(uuid(), ids.clem, 'Mme Y')).error, 'CONTACT_INTROUVABLE');
    ERR((await srv(db, `INSERT INTO client_contacts (client_id, nom, principal) VALUES ($1, 'Second principal', true)`, [ids.clem])).error, 'client_contacts_principal_idx');   // garde-fou de la base, indépendant de la fonction
    const sup = (id: string, ac: string) => rpc(db, 'contact_supprimer', [id, ...acteurArgs(ac)], ['uuid', 'uuid', 'text', 'text']);
    ERR((await sup(a.rows[0].r.contact_id, ARNAUD)).error, 'ACTION_INTERDITE');
    expect((await sup(a.rows[0].r.contact_id, CLEMENT)).error).toBe('');
    expect((await un(db, `SELECT count(*)::int n FROM admin_audit_logs WHERE action = 'contact.suppression'`)).n).toBe(1);
    ERR((await sup(a.rows[0].r.contact_id, CLEMENT)).error, 'CONTACT_INTROUVABLE');
  });

  test('suggestions : masquer / reporter (par utilisateur), sans toucher aux relances', async () => {
    const masquer = (c: string, regle: string, jusqu: string | null, a = CLEMENT) => rpc(db, 'suggestion_masquer', [c, regle, jusqu, 'pas maintenant', ...acteurArgs(a)], ['uuid', 'text', 'date', 'text', 'uuid', 'text', 'text']);
    const avant = await un(db, `SELECT count(*)::int n, count(*) FILTER (WHERE statut = 'a_faire')::int a FROM weekly_tasks`);
    expect((await masquer(ids.clem, 'client_sans_commande', jour(7))).error).toBe('');
    expect((await masquer(ids.clem, 'client_sans_commande', jour(14))).error).toBe('');   // mise à jour, pas de doublon
    expect((await masquer(ids.clem, 'client_sans_commande', jour(3), ARNAUD)).error).toBe('');
    expect(await exec(db, `SELECT par_email, jusqu_au::text j FROM crm_suggestions_masquees ORDER BY par_email`)).toEqual([{ par_email: MEL[ARNAUD], j: jour(3) }, { par_email: MEL[CLEMENT], j: jour(14) }]);
    ERR((await masquer(ids.clem, 'Regle Invalide', jour(7))).error, 'REGLE_INVALIDE');
    ERR((await masquer(ids.clem, 'x_y', jour(-1))).error, 'ECHEANCE_INVALIDE');
    ERR((await masquer(uuid(), 'x_y', jour(5))).error, 'CLIENT_INTROUVABLE');
    expect(await un(db, `SELECT count(*)::int n, count(*) FILTER (WHERE statut = 'a_faire')::int a FROM weekly_tasks`)).toEqual(avant);
  });

  test('suppression d\'un compte client : l\'historique survit (lien annulé, libellé conservé) ; contacts supprimés avec le compte', async () => {
    const c = (await un(db, `INSERT INTO client_accounts (nom, societe, email, status) VALUES ('Éphémère', 'Éphémère', 'e@x.fr', 'actif') RETURNING id`)).id;
    await srv(db, `SELECT client_attribuer($1, $2, $3, 'attribution', $4, $5, 'admin', NULL)`, [c, CLEMENT, MEL[CLEMENT], ADMIN, MEL[ADMIN]]);
    const n = await noter(db, { client: c, action: 'rappeler', echeance: jour(2) });
    await rpc(db, 'contact_enregistrer', [null, c, 'Mme E', null, null, null, false, null, ...acteurArgs(CLEMENT)], ['uuid', 'uuid', 'text', 'text', 'text', 'text', 'boolean', 'text', 'uuid', 'text', 'text']);
    expect((await srv(db, `DELETE FROM client_accounts WHERE id = $1`, [c])).error).toBe('');
    expect(await un(db, `SELECT client_id, client_libelle FROM client_interactions WHERE id = $1`, [n.rows[0].r.interaction_id])).toEqual({ client_id: null, client_libelle: 'Éphémère' });
    expect(await un(db, `SELECT client_id, client_libelle, statut FROM weekly_tasks WHERE id = $1`, [n.rows[0].r.relance_id])).toEqual({ client_id: null, client_libelle: 'Éphémère', statut: 'a_faire' });
    expect((await un(db, `SELECT count(*)::int n FROM client_contacts WHERE client_id = $1`, [c])).n).toBe(0);
  });

  test('non-régression : les 6 tâches d\'origine intactes à la fin, aucune table TVA, M2 sans instruction destructive ni TVA', async () => {
    expect((await exec(db, `SELECT id, content, done, created_at, done_at FROM weekly_tasks WHERE cle_idempotence IS NULL AND type = 'tache' AND content = ANY($1) ORDER BY content`, [TACHES]))).toEqual(tachesAvant);
    const corps = M2.replace(/--[^\n]*/g, '');
    expect(corps).not.toMatch(/\bDROP\s+TABLE\b|^\s*TRUNCATE\s+\w|\bDROP\s+COLUMN\b|\bDELETE\s+FROM\s+(weekly_tasks|client_interactions|client_accounts|orders|admin_audit)/im);
    expect(corps).not.toMatch(/tva|vat/i);
    expect(corps).not.toMatch(/prix_achat|pump|marge|frais_import|unit_cost/i);          // le module n'expose aucun coût
    expect(await un(db, `SELECT count(*)::int n FROM pg_proc WHERE proname = 'order_create_checked'`)).toEqual({ n: 1 });
  });
});

const DROITS = lire('crm_activites_droits.sql');

test.describe.serial('CRM M2 — moindre privilège de service_role (crm_activites_droits.sql, base locale)', () => {
  let db: PGlite; let ids: Record<string, string>; let avantDroits: { tables: any[]; fonctions: any[]; colonnes: any[] };
  // Autorisations de TOUT ce qui n'est pas visé par la migration de droits (BL, commandes, stocks, clients, produits, journal…)
  const hors = ['client_interactions', 'crm_delegations', 'crm_suggestions_masquees', 'weekly_tasks', 'client_contacts'];
  const instantane = async () => ({
    tables: await exec(db, `SELECT table_name, grantee, privilege_type FROM information_schema.role_table_grants WHERE table_schema = 'public' AND table_name <> ALL($1) ORDER BY 1, 2, 3`, [hors]),
    colonnes: await exec(db, `SELECT table_name, column_name, grantee, privilege_type FROM information_schema.column_privileges WHERE table_schema = 'public' AND table_name <> ALL($1) AND grantee IN ('anon','authenticated','service_role') ORDER BY 1, 2, 3, 4`, [hors]),
    fonctions: await exec(db, `SELECT p.oid::regprocedure::text f, r.rolname, has_function_privilege(r.oid, p.oid, 'EXECUTE') x FROM pg_proc p CROSS JOIN pg_roles r WHERE p.pronamespace = 'public'::regnamespace AND r.rolname IN ('anon','authenticated','service_role')
      AND p.proname NOT IN ('client_interactions_proteger', 'weekly_tasks_proteger', 'crm_delegations_proteger') ORDER BY 1, 2`),
  });
  test.beforeAll(async () => { ({ db, ids } = await baseM2()); await db.exec(M2); avantDroits = await instantane(); await db.exec(DROITS); });
  test.afterAll(async () => { await db.close(); });

  test('droits : plus aucun DELETE/TRUNCATE sur activités, relances, délégations ni suggestions ; DELETE conservé seulement pour les interlocuteurs', async () => {
    const droits = async (t: string) => (await exec(db, `SELECT privilege_type p FROM information_schema.role_table_grants WHERE table_schema = 'public' AND table_name = $1 AND grantee = 'service_role' ORDER BY 1`, [t])).map(r => r.p);
    expect(await droits('client_interactions')).toEqual(['INSERT', 'SELECT', 'UPDATE']);
    expect(await droits('crm_delegations')).toEqual(['INSERT', 'SELECT', 'UPDATE']);
    expect(await droits('crm_suggestions_masquees')).toEqual(['INSERT', 'SELECT', 'UPDATE']);
    expect(await droits('weekly_tasks')).toEqual(['INSERT', 'SELECT', 'UPDATE']);
    expect(await droits('client_contacts')).toEqual(['DELETE', 'INSERT', 'SELECT', 'UPDATE']);
    for (const t of ['client_interactions', 'crm_delegations', 'weekly_tasks', 'crm_suggestions_masquees'])
      ERR((await srv(db, `DELETE FROM ${t}`)).error, 'permission denied');
    ERR((await srv(db, `TRUNCATE client_interactions`)).error, 'permission denied');
    for (const r of ['anon', 'authenticated']) expect((await un(db, `SELECT has_table_privilege('${r}', 'client_interactions', 'SELECT') a`)).a).toBe(false);
  });

  test('toutes les fonctions légitimes continuent de fonctionner avec ces droits réduits (activité, relance, report, clôture, correction, annulation, contacts, délégation, suggestion)', async () => {
    const n = await noter(db, { client: ids.clem, action: 'rappeler', echeance: jour(2) });
    expect(n.error).toBe('');
    const rel = n.rows[0].r.relance_id as string;
    expect((await rpc(db, 'relance_reporter', [rel, jour(4), 'Client absent', ...acteurArgs(CLEMENT)], ['uuid', 'date', 'text', 'uuid', 'text', 'text'])).error).toBe('');
    expect((await rpc(db, 'relance_cloturer', [rel, 'faite', null, ...acteurArgs(CLEMENT)], ['uuid', 'text', 'text', 'uuid', 'text', 'text'])).error).toBe('');
    const p = await programmer(db, ids.clem, { echeance: jour(3) }); expect(p.error).toBe('');
    expect((await rpc(db, 'relance_reassigner', [p.rows[0].r.relance_id, ARNAUD, MEL[ARNAUD], 'Congés', ...acteurArgs(ADMIN)], ['uuid', 'uuid', 'text', 'text', 'uuid', 'text', 'text'])).error).toBe('');
    const i = n.rows[0].r.interaction_id as string;
    expect((await rpc(db, 'interaction_corriger', [i, 'echange', 'Corrigé', null, null, ...acteurArgs(CLEMENT)], ['uuid', 'text', 'text', 'text', 'text', 'uuid', 'text', 'text'])).error).toBe('');
    expect((await rpc(db, 'interaction_annuler', [i, 'Saisie en double', ...acteurArgs(CLEMENT)], ['uuid', 'text', 'uuid', 'text', 'text'])).error).toBe('');
    const c = await rpc(db, 'contact_enregistrer', [null, ids.clem, 'Mme Dupont', null, null, null, true, null, ...acteurArgs(CLEMENT)], ['uuid', 'uuid', 'text', 'text', 'text', 'text', 'boolean', 'text', 'uuid', 'text', 'text']);
    expect(c.error).toBe('');
    expect((await rpc(db, 'contact_supprimer', [c.rows[0].r.contact_id, ...acteurArgs(CLEMENT)], ['uuid', 'uuid', 'text', 'text'])).error).toBe('');
    const d = await rpc(db, 'delegation_accorder', [CLEMENT, MEL[CLEMENT], ARNAUD, MEL[ARNAUD], null, 'Congés', ...acteurArgs(ADMIN)], ['uuid', 'text', 'uuid', 'text', 'date', 'text', 'uuid', 'text', 'text']);
    expect(d.error).toBe('');
    expect((await rpc(db, 'delegation_revoquer', [d.rows[0].r.delegation_id, 'Retour', ...acteurArgs(ADMIN)], ['uuid', 'text', 'uuid', 'text', 'text'])).error).toBe('');
    expect((await rpc(db, 'suggestion_masquer', [ids.clem, 'client_sans_commande', jour(7), null, ...acteurArgs(CLEMENT)], ['uuid', 'text', 'date', 'text', 'uuid', 'text', 'text'])).error).toBe('');
    expect((await srv(db, `INSERT INTO weekly_tasks (content) VALUES ('Tâche générale')`)).error).toBe('');
    expect((await srv(db, `UPDATE weekly_tasks SET done = true, done_at = now() WHERE content = 'Tâche générale'`)).error).toBe('');
  });

  test('la suppression d\'un compte client (cascade, SET NULL) fonctionne toujours et conserve l\'historique', async () => {
    const c = (await un(db, `INSERT INTO client_accounts (nom, societe, email, status) VALUES ('Éphémère', 'Éphémère', 'e@x.fr', 'actif') RETURNING id`)).id;
    await srv(db, `SELECT client_attribuer($1, $2, $3, 'attribution', $4, $5, 'admin', NULL)`, [c, CLEMENT, MEL[CLEMENT], ADMIN, MEL[ADMIN]]);
    const n = await noter(db, { client: c, action: 'rappeler', echeance: jour(2) });
    await rpc(db, 'contact_enregistrer', [null, c, 'Mme E', null, null, null, false, null, ...acteurArgs(CLEMENT)], ['uuid', 'uuid', 'text', 'text', 'text', 'text', 'boolean', 'text', 'uuid', 'text', 'text']);
    await rpc(db, 'suggestion_masquer', [c, 'client_sans_commande', jour(5), null, ...acteurArgs(CLEMENT)], ['uuid', 'text', 'date', 'text', 'uuid', 'text', 'text']);
    expect((await srv(db, `DELETE FROM client_accounts WHERE id = $1`, [c])).error).toBe('');
    expect(await un(db, `SELECT client_id, client_libelle FROM client_interactions WHERE id = $1`, [n.rows[0].r.interaction_id])).toEqual({ client_id: null, client_libelle: 'Éphémère' });
    expect((await un(db, `SELECT client_id FROM weekly_tasks WHERE id = $1`, [n.rows[0].r.relance_id])).client_id).toBeNull();
    expect(await un(db, `SELECT (SELECT count(*) FROM client_contacts WHERE client_id = $1)::int c, (SELECT count(*) FROM crm_suggestions_masquees WHERE client_id = $1)::int s`, [c])).toEqual({ c: 0, s: 0 });
  });

  test('rien d\'autre ne change : les autorisations des BL, commandes, stocks, clients, produits, journal et de toutes les autres fonctions (dont les SECURITY DEFINER existantes) sont identiques avant et après', async () => {
    const apres = await instantane();
    expect(avantDroits.tables.length).toBeGreaterThan(50);
    expect(apres.tables).toEqual(avantDroits.tables);
    expect(apres.colonnes).toEqual(avantDroits.colonnes);
    expect(apres.fonctions).toEqual(avantDroits.fonctions);
    // les fonctions SECURITY DEFINER déjà présentes (numéro de BL, signatures) continuent de fonctionner pour service_role
    const definer = await exec(db, `SELECT proname FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND prosecdef ORDER BY 1`);
    expect(definer.length).toBeGreaterThan(0);
    expect((await srv(db, `SELECT next_bl_number() AS n`)).error).toBe('');
    // aucune des tables de BL ne recouvre de droit de suppression (inchangé depuis la phase 0)
    expect((await un(db, `SELECT has_table_privilege('service_role', 'bl_signatures', 'DELETE') a`)).a).toBe(false);
  });

  test('rejouable sans effet ; aucune fonction SECURITY DEFINER dans M2 (20 fonctions : 14 appelées par le serveur, 3 aides internes, 3 déclencheurs)', async () => {
    await db.exec(DROITS);
    expect(DROITS.replace(/--[^\n]*/g, '')).not.toMatch(/\bGRANT\b|\bDROP\b|\bDELETE\s+FROM\b|\bINSERT\b/i);
    const f = await exec(db, `SELECT p.proname, p.prosecdef, has_function_privilege('service_role', p.oid, 'EXECUTE') srv FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace
      AND (p.proname ~ '^(interaction_|relance_|contact_|delegation_|suggestion_|crm_)' OR p.proname IN ('client_interactions_proteger', 'weekly_tasks_proteger')) ORDER BY 1`);
    expect(f).toHaveLength(20);
    expect(f.filter(x => x.prosecdef)).toEqual([]);
    expect(f.filter(x => x.srv)).toHaveLength(17);          // 14 appelées par le serveur + 3 aides internes appelées par elles
    expect(f.filter(x => !x.srv).map(x => x.proname).sort()).toEqual(['client_interactions_proteger', 'crm_delegations_proteger', 'weekly_tasks_proteger']);
  });
});
