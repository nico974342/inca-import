import type { APIRoute } from 'astro';
import { createAuthClient, supabaseAdmin } from '../../../../lib/supabase';
import { fetchReservedByProduct, toAvailability } from '../../../../lib/stock';
import { isAdmin } from '../../../../lib/roles';
import { SHIPMENT_ACTIVE_STATUSES } from '../../../../lib/constants';

// Vérification de fraîcheur avant "Préparer la commande" : la page a pu être
// ouverte il y a longtemps (un autre onglet, une réception ou un arrivage
// enregistré entre-temps) — cette route renvoie l'état ACTUEL (stock
// disponible, prix, arrivages restants) pour les seuls produits du
// récapitulatif, que le client compare à l'instantané affiché avant de
// laisser confirmer. Lecture seule, aucune écriture.

export const GET: APIRoute = async ({ request, cookies, url }) => {
  const supabase = createAuthClient(request, cookies);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user || !isAdmin(user)) return new Response('Non autorisé', { status: 401 });

  const idsParam = url.searchParams.get('ids') ?? '';
  const ids = idsParam.split(',').map(s => s.trim()).filter(Boolean);
  if (ids.length === 0) {
    return new Response(JSON.stringify({ products: {} }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }

  const { data: products, error: productsErr } = await supabaseAdmin
    .from('products')
    .select('id, stock_quantity, prix_achat_moyen_ht')
    .in('id', ids);
  if (productsErr) return new Response('Erreur de lecture', { status: 500 });

  const reserved = await fetchReservedByProduct(ids);

  const { data: transitRows } = await supabaseAdmin
    .from('shipment_items')
    .select('product_id, quantity, received_quantity, shipments!inner(status, eta)')
    .in('product_id', ids)
    .in('shipments.status', SHIPMENT_ACTIVE_STATUSES as readonly string[]);

  const transitByProduct = new Map<string, { qty: number; etas: (string | null)[] }>();
  for (const row of (transitRows ?? [])) {
    if (!row.product_id) continue;
    const remaining = (row.quantity ?? 0) - (row.received_quantity ?? 0);
    if (remaining <= 0) continue;
    const cur = transitByProduct.get(row.product_id) ?? { qty: 0, etas: [] };
    cur.qty += remaining;
    cur.etas.push((row as any).shipments?.eta ?? null);
    transitByProduct.set(row.product_id, cur);
  }

  const out: Record<string, { stockDisponible: number; pump: number | null; transitQty: number }> = {};
  for (const p of (products ?? [])) {
    const avail = toAvailability(p.stock_quantity, reserved.get(p.id) ?? 0);
    const transit = transitByProduct.get(p.id);
    out[p.id] = {
      stockDisponible: avail.available,
      pump: (p as any).prix_achat_moyen_ht != null ? Number((p as any).prix_achat_moyen_ht) : null,
      transitQty: transit?.qty ?? 0,
    };
  }

  return new Response(JSON.stringify({ products: out }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
};
