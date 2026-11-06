import { supabaseAdmin } from './supabase';
import { findClientByEmail } from './clients';
import { isClientRole } from './roles';
import { REAPPRO_WEEKS_LOOKBACK } from './constants';

/**
 * Règle de visibilité catalogue — SOURCE UNIQUE côté TypeScript.
 *
 *   products.visible_catalogue = true  → visible par tout le monde
 *   products.visible_catalogue = false → invisible, SAUF pour les clients
 *     explicitement autorisés (table client_product_access, un client à la fois)
 *   visiteur non connecté / staff       → jamais d'accès aux produits masqués
 *
 * Toute page, route ou requête qui expose des produits à un client passe par
 * ces fonctions. Le même contrôle existe en SQL dans order_create_checked
 * (rempart définitif à la commande) — voir
 * supabase/migrations/client_product_access.sql ; les deux doivent rester alignés.
 */

/** Ids des produits masqués auxquels ce client a accès (ensemble vide si aucun). */
export async function fetchGrantedProductIds(clientId: string | null | undefined): Promise<Set<string>> {
  if (!clientId) return new Set();
  const { data, error } = await supabaseAdmin
    .from('client_product_access')
    .select('product_id')
    .eq('client_id', clientId);
  if (error) {
    // Échec fermé : sans lecture fiable, aucun produit masqué n'est exposé.
    console.error('[catalogue] client_product_access:', error.message);
    return new Set();
  }
  return new Set((data ?? []).map(r => r.product_id as string));
}

/**
 * Produits masqués accessibles à l'utilisateur connecté. Seul un compte de rôle
 * client rattaché à une fiche (par e-mail, comme partout) peut en avoir ;
 * visiteur anonyme et staff → ensemble vide.
 */
export async function fetchGrantedForUser(
  user: { email?: string | null; app_metadata?: { role?: string | null; [k: string]: any } | null } | null | undefined,
): Promise<Set<string>> {
  if (!user || !isClientRole(user)) return new Set();
  const account = await findClientByEmail<{ id: string }>(user.email, 'id');
  return fetchGrantedProductIds(account?.id);
}

/** Un produit est-il visible pour quelqu'un qui détient ces autorisations ? */
export function isProductVisibleTo(
  product: { id: string; visible_catalogue?: boolean | null },
  granted: Set<string>,
): boolean {
  return product.visible_catalogue !== false || granted.has(product.id);
}

/**
 * Restreint une requête `from('products')` aux produits visibles pour ces
 * autorisations : visibles pour tous, plus les produits masqués accordés.
 */
export function whereVisibleTo<Q>(query: Q, granted: Set<string>): Q {
  const q = query as any;
  if (granted.size === 0) return q.eq('visible_catalogue', true) as Q;
  return q.or(`visible_catalogue.eq.true,id.in.(${[...granted].join(',')})`) as Q;
}

// Mêmes statuts et même fenêtre que la vitesse de vente de l'admin (voir REAPPRO_WEEKS_LOOKBACK).
const STATUTS_VENTES = ['confirmee', 'en_preparation', 'expediee', 'livree'];

/**
 * Quantités vendues par produit sur les REAPPRO_WEEKS_LOOKBACK dernières semaines : UNE agrégation pour tout le
 * catalogue (jamais une requête par produit). Lue par blocs de 1 000 lignes car l'API plafonne chaque réponse.
 * Échec de lecture → table vide : le catalogue s'affiche, simplement trié par ordre alphabétique.
 */
export async function fetchVentesParProduit(now: Date = new Date()): Promise<Map<string, number>> {
  const ventes = new Map<string, number>();
  const depuis = new Date(now.getTime() - REAPPRO_WEEKS_LOOKBACK * 7 * 24 * 60 * 60 * 1000).toISOString();
  const TAILLE = 1000;
  for (let debut = 0; ; debut += TAILLE) {
    const { data, error } = await supabaseAdmin
      .from('order_items')
      .select('product_id, quantity, orders!inner(status, created_at)')
      .in('orders.status', STATUTS_VENTES)
      .gte('orders.created_at', depuis)
      .order('id', { ascending: true })
      .range(debut, debut + TAILLE - 1);
    if (error) {
      console.error('[catalogue] ventes:', error.message);
      return new Map();
    }
    for (const r of data ?? []) {
      if (r.product_id) ventes.set(r.product_id, (ventes.get(r.product_id) ?? 0) + Number(r.quantity ?? 0));
    }
    if ((data?.length ?? 0) < TAILLE) return ventes;
  }
}
