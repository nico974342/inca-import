import type { APIRoute } from 'astro';
import { createAuthClient, supabaseAdmin } from '../../../../../lib/supabase';
import { logAdminAction } from '../../../../../lib/audit';

export const POST: APIRoute = async ({ params, request, cookies }) => {
  const supabase = createAuthClient(request, cookies);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user || user.user_metadata?.role === 'client') {
    return new Response('Non autorisé', { status: 401 });
  }

  const { id } = params;
  if (!id) return new Response('Non trouvé', { status: 404 });

  const { data: order } = await supabaseAdmin.from('orders').select('nom, societe, status').eq('id', id).single();

  const { data: items } = await supabaseAdmin
    .from('order_items')
    .select('quantity, price_ht_snapshot, pump_snapshot')
    .eq('order_id', id);

  let caHt = 0, margeHt = 0, hasPump = false;
  for (const item of items ?? []) {
    const prix = item.price_ht_snapshot != null ? Number(item.price_ht_snapshot) : null;
    const pump = item.pump_snapshot != null ? Number(item.pump_snapshot) : null;
    if (prix == null) continue;
    caHt += prix * item.quantity;
    if (pump != null) { margeHt += (prix - pump) * item.quantity; hasPump = true; }
  }

  // Deleting a livree order removes its CA/margin from history — restore
  // the stock that was decremented for it, same as a status cancel would.
  const wasLivree = order?.status === 'livree';
  if (wasLivree) {
    const { error: restoreErr } = await supabaseAdmin.rpc('order_cancel_livree', { p_order_id: id });
    if (restoreErr) console.error('[orders/delete] order_cancel_livree failed:', restoreErr.message);
  }

  await supabaseAdmin.from('order_items').delete().eq('order_id', id);
  await supabaseAdmin.from('orders').delete().eq('id', id);

  await logAdminAction({
    adminEmail: user.email ?? 'inconnu',
    action: 'commande.suppression',
    targetType: 'order',
    targetId: id,
    targetLabel: order ? `${order.societe ?? order.nom}` : id,
    details: {
      statut: order?.status ?? null,
      stock_restaure: wasLivree,
      ca_ht_supprime: caHt,
      marge_ht_supprimee: hasPump ? margeHt : null,
    },
  });

  return Response.redirect(new URL('/admin/commandes', request.url).toString(), 303);
};
