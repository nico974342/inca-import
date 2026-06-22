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
    .select('id, email')
    .eq('id', id)
    .single();

  if (!client) return new Response('Non trouvé', { status: 404 });

  // Collect all order IDs for this client (by email)
  const { data: orderRows } = await supabaseAdmin
    .from('orders')
    .select('id')
    .eq('email', client.email ?? '');
  const orderIds = (orderRows ?? []).map(o => o.id);

  // Delete in FK order
  if (orderIds.length) {
    await supabaseAdmin.from('order_items').delete().in('order_id', orderIds);
    await supabaseAdmin.from('orders').delete().in('id', orderIds);
  }
  await supabaseAdmin.from('delivery_notes').delete().eq('client_id', id);
  await supabaseAdmin.from('client_accounts').delete().eq('id', id);

  return Response.redirect(new URL('/admin/clients?deleted=1', request.url).toString(), 303);
};
