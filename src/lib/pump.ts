import { supabaseAdmin } from './supabase';

/**
 * Recompute prix_achat_moyen_ht for a product from ALL its reception items.
 * Formula: SUM(qty × cost) / SUM(qty) — true weighted average, order-independent.
 * Returns null if the product has no reception records at all.
 */
export async function recalcPump(productId: string): Promise<number | null> {
  const { data: items } = await supabaseAdmin
    .from('stock_reception_items')
    .select('quantity, unit_cost_ht')
    .eq('product_id', productId);

  if (!items || items.length === 0) return null;

  const totalQty  = items.reduce((s, i) => s + i.quantity, 0);
  const totalCost = items.reduce((s, i) => s + i.quantity * i.unit_cost_ht, 0);

  return totalQty > 0 ? Math.round((totalCost / totalQty) * 10000) / 10000 : null;
}
