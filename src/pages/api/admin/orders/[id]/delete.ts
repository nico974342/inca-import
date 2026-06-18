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

  await supabaseAdmin.from('order_items').delete().eq('order_id', id);
  await supabaseAdmin.from('orders').delete().eq('id', id);

  return Response.redirect(new URL('/admin/commandes', request.url).toString(), 303);
};
