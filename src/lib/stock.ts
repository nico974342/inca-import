import { supabaseAdmin } from './supabase';

/**
 * Statuts qui immobilisent du stock. Doit rester aligné sur la fonction
 * Postgres stock_reserving_statuses() : c'est elle qui fait foi côté
 * validation, celle-ci ne sert qu'à l'affichage.
 *
 * « livree » est absent parce que le physique a déjà été décrémenté, et
 * « annulee » parce que la réservation est libérée.
 */
export const STOCK_RESERVING_STATUSES = ['en_attente', 'confirmee', 'en_preparation', 'expediee'] as const;

export type Availability = {
  /** Ce qui est dans l'entrepôt. */
  physical: number;
  /** Engagé sur des commandes non encore livrées. */
  reserved: number;
  /** physique − réservé. Peut être négatif si une survente est déjà passée. */
  available: number;
};

/** Disponibilité d'un produit à partir du physique et du réservé. */
export function toAvailability(physical: number | null | undefined, reserved: number): Availability {
  const phys = physical ?? 0;
  return { physical: phys, reserved, available: phys - reserved };
}

/**
 * Quantités réservées par produit, en une requête.
 *
 * L'agrégation se fait ici plutôt que via la vue product_availability : les
 * pages ont déjà chargé leurs produits, et un second aller-retour agrégé se
 * combine mieux qu'une jointure PostgREST sur une vue.
 */
export async function fetchReservedByProduct(productIds?: string[]): Promise<Map<string, number>> {
  let query = supabaseAdmin
    .from('order_items')
    .select('product_id, quantity, orders!inner(status)')
    .in('orders.status', STOCK_RESERVING_STATUSES as readonly string[]);

  if (productIds && productIds.length > 0) query = query.in('product_id', productIds);

  const { data, error } = await query;
  if (error) {
    // Un échec ici ferait passer du réservé pour du disponible, donc de la
    // survente. On remonte plutôt que de renvoyer une carte vide silencieuse.
    throw new Error(`fetchReservedByProduct: ${error.message}`);
  }

  const reserved = new Map<string, number>();
  for (const row of data ?? []) {
    if (!row.product_id) continue;
    reserved.set(row.product_id, (reserved.get(row.product_id) ?? 0) + (row.quantity ?? 0));
  }
  return reserved;
}

/** Disponibilité pour une liste de produits déjà chargés. */
export async function fetchAvailability<T extends { id: string; stock_quantity: number | null }>(
  products: T[],
): Promise<Map<string, Availability>> {
  const reserved = await fetchReservedByProduct(products.map(p => p.id));
  const out = new Map<string, Availability>();
  for (const p of products) out.set(p.id, toAvailability(p.stock_quantity, reserved.get(p.id) ?? 0));
  return out;
}

/** Ce qu'un client peut commander : jamais négatif. */
export function sellableQty(a: Availability | undefined): number {
  return Math.max(0, a?.available ?? 0);
}

export type OrderLineInput = {
  product_id: string;
  product_name: string;
  quantity: number;
  unit: string | null;
  price_ht_snapshot: number | null;
  tva_rate_snapshot: number | null;
  pump_snapshot: number | null;
};

export type OrderConflict = {
  product_id: string;
  product_name: string;
  requested: number;
  available: number;
};

export type OrderCreateResult =
  | { ok: true; orderId: string }
  | { ok: false; conflicts: OrderConflict[] }
  | { ok: false; error: string };

/**
 * Crée une commande en vérifiant le disponible dans la même transaction.
 *
 * C'est le seul chemin de création autorisé : la vérification préalable côté
 * page ne sert qu'à l'ergonomie, elle ne protège de rien puisque deux
 * requêtes concurrentes la franchissent toutes les deux.
 */
export async function createOrderChecked(
  order: {
    user_id: string | null;
    nom: string;
    societe: string;
    telephone: string;
    email: string | null;
    notes: string | null;
  },
  items: OrderLineInput[],
): Promise<OrderCreateResult> {
  const { data, error } = await supabaseAdmin.rpc('order_create_checked', {
    p_order: order,
    p_items: items,
  });

  if (error) {
    console.error('[stock] order_create_checked:', error.message);
    return { ok: false, error: error.message };
  }

  // La fonction renvoie une table d'une seule ligne.
  const row = Array.isArray(data) ? data[0] : data;
  const conflicts = (row?.r_conflicts ?? []) as OrderConflict[];

  if (conflicts.length > 0) return { ok: false, conflicts };
  if (!row?.r_order_id) return { ok: false, error: 'aucun identifiant de commande renvoyé' };

  return { ok: true, orderId: row.r_order_id };
}

/** Résumé lisible d'un conflit, pour un message d'erreur. */
export function describeConflicts(conflicts: OrderConflict[]): string {
  return conflicts
    .map(c => `${c.product_name} : ${c.requested} demandé${c.requested > 1 ? 's' : ''}, ${c.available} disponible${c.available > 1 ? 's' : ''}`)
    .join(' · ');
}
