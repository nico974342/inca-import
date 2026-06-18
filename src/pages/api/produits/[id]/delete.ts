import type { APIRoute } from 'astro';
import { createAuthClient, supabaseAdmin } from '../../../../lib/supabase';

export const POST: APIRoute = async ({ params, request, cookies, redirect }) => {
  const supabase = createAuthClient(request, cookies);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user || user.user_metadata?.role === 'client') {
    return new Response('Non autorisé', { status: 401 });
  }

  const { id } = params;
  if (!id) return new Response('Not found', { status: 404 });

  await supabaseAdmin.from('products').delete().eq('id', id);
  return redirect('/admin/produits');
};
