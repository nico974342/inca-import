import type { APIRoute } from 'astro';
import { createAuthClient, supabaseAdmin } from '../../../../../lib/supabase';
import { logAdminAction } from '../../../../../lib/audit';
import { normalizeEmail } from '../../../../../lib/clients';

export const POST: APIRoute = async ({ params, request, cookies }) => {
  const supabase = createAuthClient(request, cookies);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user || user.user_metadata?.role === 'client') {
    return new Response('Non autorisé', { status: 401 });
  }

  const { id } = params;
  if (!id) return new Response('Non trouvé', { status: 404 });

  const { data: client } = await supabaseAdmin
    .from('client_accounts')
    .select('id, email, user_id')
    .eq('id', id)
    .single();

  if (!client) return new Response('Non trouvé', { status: 404 });

  // 1. Delete order_items + orders (matched by email OR user_id)
  const emailFilter = client.email ? normalizeEmail(client.email) : '';
  const { data: ordersByEmail } = emailFilter
    ? await supabaseAdmin.from('orders').select('id, status').eq('email', emailFilter)
    : { data: [] as { id: string; status: string }[] };
  const { data: ordersByUser } = client.user_id
    ? await supabaseAdmin.from('orders').select('id, status').eq('user_id', client.user_id)
    : { data: [] as { id: string; status: string }[] };

  const ordersById = new Map<string, { id: string; status: string }>();
  for (const o of [...(ordersByEmail ?? []), ...(ordersByUser ?? [])]) ordersById.set(o.id, o);
  const orderIds = [...ordersById.keys()];

  // CA/margin impact for the audit trail + stock restore for livree orders
  let caHt = 0, margeHt = 0, hasPump = false;
  if (orderIds.length) {
    const { data: allItems } = await supabaseAdmin
      .from('order_items')
      .select('order_id, quantity, price_ht_snapshot, pump_snapshot')
      .in('order_id', orderIds);

    for (const item of allItems ?? []) {
      const prix = item.price_ht_snapshot != null ? Number(item.price_ht_snapshot) : null;
      const pump = item.pump_snapshot != null ? Number(item.pump_snapshot) : null;
      if (prix == null) continue;
      caHt += prix * item.quantity;
      if (pump != null) { margeHt += (prix - pump) * item.quantity; hasPump = true; }
    }

    const livreeIds = orderIds.filter(oid => ordersById.get(oid)?.status === 'livree');
    for (const oid of livreeIds) {
      const { error: restoreErr } = await supabaseAdmin.rpc('order_cancel_livree', { p_order_id: oid });
      if (restoreErr) console.error('[delete client] order_cancel_livree failed:', oid, restoreErr.message);
    }

    await supabaseAdmin.from('order_items').delete().in('order_id', orderIds);
    await supabaseAdmin.from('orders').delete().in('id', orderIds);
  }

  // 2. Delete delivery_notes linked to this client_account
  await supabaseAdmin.from('delivery_notes').delete().eq('client_id', id);

  // 3. Delete cart_items linked to the auth user
  if (client.user_id) {
    await supabaseAdmin.from('cart_items').delete().eq('user_id', client.user_id);
  }

  // 4. Delete the client_accounts row
  await supabaseAdmin.from('client_accounts').delete().eq('id', id);

  // 5. Delete the auth user (after removing client_accounts to avoid FK issues)
  if (client.user_id) {
    const { error: authErr } = await supabaseAdmin.auth.admin.deleteUser(client.user_id);
    if (authErr) console.error('[delete client] auth.deleteUser error:', authErr.message);
  }

  await logAdminAction({
    adminEmail: user.email ?? 'inconnu',
    action: 'client.suppression',
    targetType: 'client',
    targetId: id,
    targetLabel: client.email ?? id,
    details: {
      orders_deleted: orderIds.length,
      ca_ht_supprime: caHt,
      marge_ht_supprimee: hasPump ? margeHt : null,
    },
  });

  return Response.redirect(new URL('/admin/clients?deleted=1', request.url).toString(), 303);
};
