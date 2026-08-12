import type { APIRoute } from 'astro';
import { createAuthClient, supabaseAdmin } from '../../../../../lib/supabase';
import { logAdminAction } from '../../../../../lib/audit';
import { normalizeEmail, findAuthUserIdByEmail } from '../../../../../lib/clients';

export const POST: APIRoute = async ({ params, request, cookies }) => {
  const supabase = createAuthClient(request, cookies);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user || user.user_metadata?.role === 'client') {
    return new Response('Non autorisé', { status: 401 });
  }

  const { id } = params;
  if (!id) return new Response('Non trouvé', { status: 404 });

  const base = new URL(request.url).origin;
  // Every failure path lands back on the list with a readable reason instead of
  // a blank 404 / false success banner.
  const fail = (code: string, detail: string) => {
    console.error(`[delete client] ${code}:`, detail);
    return Response.redirect(
      `${base}/admin/clients?delete_error=${code}&detail=${encodeURIComponent(detail.slice(0, 200))}`,
      303,
    );
  };

  // NB: client_accounts has no user_id column — the auth user is found by email.
  const { data: client, error: clientErr } = await supabaseAdmin
    .from('client_accounts')
    .select('id, email, nom')
    .eq('id', id)
    .single();

  if (clientErr) return fail('lecture', clientErr.message);
  if (!client)   return fail('introuvable', `Aucun client avec l'id ${id}`);

  let authUserId: string | null = null;
  try {
    authUserId = await findAuthUserIdByEmail(client.email);
  } catch (e) {
    return fail('auth_lookup', e instanceof Error ? e.message : String(e));
  }

  // 1. Delete order_items + orders (matched by email OR auth user id)
  const emailFilter = client.email ? normalizeEmail(client.email) : '';

  const { data: ordersByEmail, error: obeErr } = emailFilter
    ? await supabaseAdmin.from('orders').select('id, status').eq('email', emailFilter)
    : { data: [] as { id: string; status: string }[], error: null };
  if (obeErr) return fail('lecture_commandes', obeErr.message);

  const { data: ordersByUser, error: obuErr } = authUserId
    ? await supabaseAdmin.from('orders').select('id, status').eq('user_id', authUserId)
    : { data: [] as { id: string; status: string }[], error: null };
  if (obuErr) return fail('lecture_commandes', obuErr.message);

  const ordersById = new Map<string, { id: string; status: string }>();
  for (const o of [...(ordersByEmail ?? []), ...(ordersByUser ?? [])]) ordersById.set(o.id, o);
  const orderIds = [...ordersById.keys()];

  // CA/margin impact for the audit trail + stock restore for livree orders
  let caHt = 0, margeHt = 0, hasPump = false;
  if (orderIds.length) {
    const { data: allItems, error: itemsErr } = await supabaseAdmin
      .from('order_items')
      .select('order_id, quantity, price_ht_snapshot, pump_snapshot')
      .in('order_id', orderIds);
    if (itemsErr) return fail('lecture_lignes', itemsErr.message);

    for (const item of allItems ?? []) {
      const prix = item.price_ht_snapshot != null ? Number(item.price_ht_snapshot) : null;
      const pump = item.pump_snapshot != null ? Number(item.pump_snapshot) : null;
      if (prix == null) continue;
      caHt += prix * item.quantity;
      if (pump != null) { margeHt += (prix - pump) * item.quantity; hasPump = true; }
    }

    // Stock restore must succeed before the order disappears, otherwise the
    // returned units are lost with no way to recompute them.
    const livreeIds = orderIds.filter(oid => ordersById.get(oid)?.status === 'livree');
    for (const oid of livreeIds) {
      const { error: restoreErr } = await supabaseAdmin.rpc('order_cancel_livree', { p_order_id: oid });
      if (restoreErr) return fail('restauration_stock', `commande ${oid} : ${restoreErr.message}`);
    }

    const { error: oiErr } = await supabaseAdmin.from('order_items').delete().in('order_id', orderIds);
    if (oiErr) return fail('suppression_lignes', oiErr.message);

    const { error: oErr } = await supabaseAdmin.from('orders').delete().in('id', orderIds);
    if (oErr) return fail('suppression_commandes', oErr.message);
  }

  // 2. Delete delivery_notes linked to this client_account
  const { error: dnErr } = await supabaseAdmin.from('delivery_notes').delete().eq('client_id', id);
  if (dnErr) return fail('suppression_bl', dnErr.message);

  // 3. Delete cart_items linked to the auth user
  if (authUserId) {
    const { error: ciErr } = await supabaseAdmin.from('cart_items').delete().eq('user_id', authUserId);
    if (ciErr) return fail('suppression_panier', ciErr.message);
  }

  // 4. Delete the client_accounts row. `select()` makes PostgREST return the
  // deleted rows, so an RLS-silenced no-op can't pass as success.
  const { data: removed, error: delErr } = await supabaseAdmin
    .from('client_accounts')
    .delete()
    .eq('id', id)
    .select('id');
  if (delErr) return fail('suppression_client', delErr.message);
  if (!removed?.length) {
    return fail('suppression_client', 'La ligne client n\'a pas été supprimée (0 ligne affectée).');
  }

  // 5. Delete the auth user (after removing client_accounts to avoid FK issues).
  // Non-blocking: the client record is already gone, so report it as a partial
  // success rather than pretending nothing happened.
  let authWarning: string | null = null;
  if (authUserId) {
    const { error: authErr } = await supabaseAdmin.auth.admin.deleteUser(authUserId);
    if (authErr) {
      authWarning = authErr.message;
      console.error('[delete client] auth.deleteUser error:', authErr.message);
    }
  }

  await logAdminAction({
    adminEmail: user.email ?? 'inconnu',
    action: 'client.suppression',
    targetType: 'client',
    targetId: id,
    targetLabel: client.email ?? client.nom ?? id,
    details: {
      orders_deleted: orderIds.length,
      ca_ht_supprime: caHt,
      marge_ht_supprimee: hasPump ? margeHt : null,
      auth_user_deleted: authUserId ? !authWarning : null,
    },
  });

  const done = authWarning
    ? `/admin/clients?deleted=1&auth_warning=${encodeURIComponent(authWarning.slice(0, 200))}`
    : '/admin/clients?deleted=1';
  return Response.redirect(`${base}${done}`, 303);
};
