import type { APIRoute } from 'astro';
import { createAuthClient, supabaseAdmin } from '../../../../../lib/supabase';

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

  // Collect all order IDs for this client (by email + user_id)
  const queries = [
    supabaseAdmin.from('orders').select('id').eq('email', client.email ?? ''),
    ...(client.user_id
      ? [supabaseAdmin.from('orders').select('id').eq('user_id', client.user_id)]
      : []),
  ];
  const results = await Promise.all(queries);
  const orderIds = [...new Set(results.flatMap(r => (r.data ?? []).map(o => o.id)))];

  // Delete in FK order
  if (orderIds.length) {
    await supabaseAdmin.from('order_items').delete().in('order_id', orderIds);
    await supabaseAdmin.from('orders').delete().in('id', orderIds);
  }
  await supabaseAdmin.from('delivery_notes').delete().eq('client_id', id);
  if (client.user_id) {
    await supabaseAdmin.from('cart_items').delete().eq('user_id', client.user_id);
  }
  await supabaseAdmin.from('client_accounts').delete().eq('id', id);
  if (client.user_id) {
    await supabaseAdmin.auth.admin.deleteUser(client.user_id);
  }

  return Response.redirect(new URL('/admin/clients', request.url).toString(), 303);
};
