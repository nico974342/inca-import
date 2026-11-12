/** Socle commun des bases locales de test (PGlite) : production après la phase 0, avec les vraies fonctions de stock. Aucune connexion à Supabase. */
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';

export const lire = (f: string) => readFileSync(`supabase/migrations/${f}`, 'utf8');

export const MIGRATIONS_AVANT = [
  'orders_bl_number.sql', 'order_items_price_snapshots.sql', 'order_items_picked_column.sql', 'stock_rpc_functions.sql', 'product_adjust_stock_rpc.sql',
  'product_adjust_stock_fix.sql', 'shipments_table.sql', 'shipments_annule_receptions_partielles.sql', 'shipment_items_dlc.sql', 'suppliers_table.sql', 'stock_reserve.sql',
  'order_update_checked.sql', 'order_update_checked_price_refresh.sql', 'price_groups.sql', 'products_delai_override_moq.sql', 'commande_fournisseur_drafts_et_idempotence.sql', 'suppliers_couverture_cible.sql', 'suppliers_stable_id_matching.sql', 'dlc_lots.sql', 'products_nouveau.sql',
  'order_create_checked_active_client.sql', 'products_visible_catalogue.sql', 'client_product_access.sql', 'bl_sequence.sql', 'bl_signatures.sql', 'bl_commandes.sql', 'securite_phase0.sql',
];

export const ENV = `
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

export async function baseCommune(): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(ENV);
  for (const f of MIGRATIONS_AVANT) { try { await db.exec(lire(f)); } catch (e: any) { throw new Error(`migration ${f} : ${e.message}`); } }
  return db;
}
export const un = async (db: PGlite, q: string, p: unknown[] = []) => ((await db.query<any>(q, p)).rows)[0];
export const exec = async (db: PGlite, q: string, p: unknown[] = []) => (await db.query<any>(q, p)).rows;
export const produit = async (db: PGlite, nom: string, stock = 0) => (await un(db, `INSERT INTO products (name, price_ht, stock_quantity, tva_rate, in_stock) VALUES ($1, 10, $2, 0.085, $2 > 0) RETURNING id`, [nom, stock])).id as string;
export const commande = async (db: PGlite, lignes: { p: string; q: number; cout?: number | null; recu?: number | null }[], extra: { statut?: string; ref?: string } = {}) => {
  const s = (await un(db, `INSERT INTO shipments (supplier_name, reference, status) VALUES ('Fournisseur Test', $1, $2) RETURNING id`, [extra.ref ?? `REF-${crypto.randomUUID().slice(0, 6)}`, extra.statut ?? 'en_transit'])).id as string;
  const ids: string[] = [];
  for (const l of lignes) ids.push((await un(db, `INSERT INTO shipment_items (shipment_id, product_id, quantity, unit_cost_ht, received_quantity) VALUES ($1, $2, $3, $4, $5) RETURNING id`, [s, l.p, l.q, l.cout ?? 5, l.recu ?? null])).id);
  return { s, ids };
};
