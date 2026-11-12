/**
 * Base LOCALE (PGlite) du parcours de commande client : vraies fonctions SQL de la production (création contrôlée, disponibilité, accès aux produits masqués),
 * plus la table du panier et, au choix, la migration d'idempotence. Aucune connexion à Supabase.
 */
import { readFileSync } from 'node:fs';
import type { PGlite } from '@electric-sql/pglite';
import { baseCommune, exec, un, produit } from './panierBaseCommun';
import type { CreateurCommande, DepotCommande, LigneBrute, ResultatCreation } from '../../src/lib/commandeActions';
import type { Disponibilite } from '../../src/lib/panier';

export const MIGRATION_IDEMPOTENCE = readFileSync('supabase/migrations/orders_idempotence_cle.sql', 'utf8');

export async function basePanier(avecIdempotence = true): Promise<PGlite> {
  const db = await baseCommune();
  await db.exec(`CREATE TABLE cart_items (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL, product_id uuid NOT NULL REFERENCES products(id), quantity integer NOT NULL CHECK (quantity > 0),
    updated_at timestamptz NOT NULL DEFAULT now(), UNIQUE (user_id, product_id)); GRANT ALL ON cart_items TO service_role`);
  if (avecIdempotence) await db.exec(MIGRATION_IDEMPOTENCE);
  return db;
}

export type Client = { id: string; email: string };
export async function nouveauClient(db: PGlite, n: number, statut = 'actif'): Promise<Client> {
  const id = crypto.randomUUID(); const email = `client${n}@exemple.re`;
  await db.query(`INSERT INTO auth.users (id) VALUES ($1)`, [id]);
  await db.query(`INSERT INTO client_accounts (nom, email, status) VALUES ($1, $2, $3)`, [`Client ${n}`, email, statut]);
  return { id, email };
}
/** Produit avec un stock physique donné (en cartons) et un prix. */
export const produitStock = async (db: PGlite, nom: string, stock: number, prix = 12) => {
  const id = await produit(db, nom, stock);
  await db.query(`UPDATE products SET price_ht = $2, tva_rate = 0.085 WHERE id = $1`, [id, prix]);
  return id;
};
export const remplirPanier = async (db: PGlite, c: Client, lignes: [string, number][]) => {
  for (const [p, q] of lignes) await db.query(`INSERT INTO cart_items (user_id, product_id, quantity) VALUES ($1, $2, $3) ON CONFLICT (user_id, product_id) DO UPDATE SET quantity = $3, updated_at = now()`, [c.id, p, q]);
};
export const panierDe = async (db: PGlite, c: Client): Promise<Record<string, number>> =>
  Object.fromEntries((await exec(db, `SELECT product_id, quantity FROM cart_items WHERE user_id = $1`, [c.id])).map(r => [r.product_id, r.quantity]));
export const commandesDe = async (db: PGlite, c: Client) => exec(db, `SELECT id, status, cle_commande FROM orders WHERE user_id = $1 ORDER BY created_at`, [c.id]).catch(() => exec(db, `SELECT id, status FROM orders WHERE user_id = $1 ORDER BY created_at`, [c.id]));
export const lignesCommande = async (db: PGlite, orderId: string) => exec(db, `SELECT product_id, quantity FROM order_items WHERE order_id = $1 ORDER BY product_id`, [orderId]);
export const disponible = async (db: PGlite, p: string) => Number((await un(db, `SELECT available FROM product_availability WHERE product_id = $1`, [p])).available);

const srv = async <T>(db: PGlite, f: () => Promise<T>): Promise<T> => { await db.exec('SET ROLE service_role'); try { return await f(); } finally { await db.exec('RESET ROLE'); } };

/** Dépôt local : mêmes requêtes que src/lib/commandeSupabase.ts (mêmes règles de disponibilité et d'accès aux produits masqués). */
export function depotPglite(db: PGlite, c: Client, options: { viderEchoue?: boolean } = {}): DepotCommande {
  return {
    lireLignes: (userId) => srv(db, async () => (await exec(db, `SELECT ci.product_id, ci.quantity, p.name AS nom, NULL::text AS unit FROM cart_items ci JOIN products p ON p.id = ci.product_id WHERE ci.user_id = $1 ORDER BY ci.updated_at, ci.id`, [userId])) as LigneBrute[]),
    lireDisponibilites: (_u, ids) => srv(db, async () => {
      const lignes = await exec(db, `SELECT p.id, a.available, p.visible_catalogue,
          EXISTS (SELECT 1 FROM client_product_access cpa JOIN client_accounts ca ON ca.id = cpa.client_id WHERE lower(ca.email) = $2 AND cpa.product_id = p.id) AS autorise
        FROM products p LEFT JOIN product_availability a ON a.product_id = p.id WHERE p.id = ANY($1::uuid[])`, [ids, c.email]);
      return new Map<string, Disponibilite>(lignes.map(r => [r.id, { available: Number(r.available ?? 0), commandable: r.visible_catalogue !== false || r.autorise === true }]));
    }),
    ecrireQuantite: (userId, p, q) => srv(db, async () => { await db.query(`INSERT INTO cart_items (user_id, product_id, quantity) VALUES ($1, $2, $3) ON CONFLICT (user_id, product_id) DO UPDATE SET quantity = $3, updated_at = now()`, [userId, p, q]); }),
    retirer: (userId, p) => srv(db, async () => { await db.query(`DELETE FROM cart_items WHERE user_id = $1 AND product_id = $2`, [userId, p]); }),
    viderPanier: (userId) => srv(db, async () => {
      if (options.viderEchoue) return false;
      await db.query(`DELETE FROM cart_items WHERE user_id = $1`, [userId]);
      return Number((await un(db, `SELECT count(*)::int n FROM cart_items WHERE user_id = $1`, [userId])).n) === 0;
    }),
    derniereCommande: (userId) => srv(db, async () => {
      const o = await un(db, `SELECT id, extract(epoch FROM now() - created_at)::int AS secondes FROM orders WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1`, [userId]);
      if (!o) return null;
      return { id: o.id, secondes: Number(o.secondes), lignes: (await exec(db, `SELECT product_id, quantity FROM order_items WHERE order_id = $1`, [o.id])) as { product_id: string; quantity: number }[] };
    }),
  };
}

/** Créateur local : appelle la VRAIE fonction SQL (idempotente si la migration est chargée, sinon la création contrôlée habituelle). */
export function createurPglite(db: PGlite, c: Client, idempotent: boolean, hooks: { apresCreation?: () => void } = {}): CreateurCommande {
  return {
    idempotent,
    async creer(cle, lignes): Promise<ResultatCreation> {
      return srv(db, async () => {
        const items = [];
        for (const l of lignes) { const p = await un(db, `SELECT name, price_ht, tva_rate, prix_achat_moyen_ht FROM products WHERE id = $1`, [l.product_id]); items.push({ product_id: l.product_id, product_name: p.name, quantity: l.quantity, unit: null, price_ht_snapshot: p.price_ht, tva_rate_snapshot: p.tva_rate, pump_snapshot: p.prix_achat_moyen_ht }); }
        const entete = { user_id: c.id, nom: 'Client', societe: '', telephone: '', email: c.email, notes: null };
        let ligne: any;
        try {
          ligne = idempotent
            ? await un(db, `SELECT * FROM order_create_idempotent($1::uuid, $2::jsonb, $3::jsonb)`, [cle, JSON.stringify(entete), JSON.stringify(items)])
            : await un(db, `SELECT * FROM order_create_checked($1::jsonb, $2::jsonb)`, [JSON.stringify(entete), JSON.stringify(items)]);
        } catch (e: any) { return { ok: false, error: String(e.message ?? e).split(':')[0] }; }
        const conflits = (ligne?.r_conflicts ?? []) as any[];
        if (conflits.length > 0) return { ok: false, conflicts: conflits };
        hooks.apresCreation?.();
        return { ok: true, orderId: ligne.r_order_id, deja: !!ligne.r_deja };
      });
    },
  };
}
