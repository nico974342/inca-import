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

  const { data: client } = await supabaseAdmin
    .from('client_accounts')
    .select('id, email, user_id')
    .eq('id', id)
    .single();

  if (!client) return new Response('Non trouvé', { status: 404 });

  // 1. Delete order_items + orders (matched by email OR user_id)
  const emailFilter = client.email ?? '';
  const { data: ordersByEmail } = emailFilter
    ? await supabaseAdmin.from('orders').select('id').eq('email', emailFilter)
    : { data: [] };
  const { data: ordersByUser } = client.user_id
    ? await supabaseAdmin.from('orders').select('id').eq('user_id', client.user_id)
    : { data: [] };

  const orderIds = [
    ...new Set([
      ...(ordersByEmail ?? []).map(o => o.id),
      ...(ordersByUser  ?? []).map(o => o.id),
    ]),
  ];

  if (orderIds.length) {
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
    details: { orders_deleted: orderIds.length },
  });

  return Response.redirect(new URL('/admin/clients?deleted=1', request.url).toString(), 303);
};
