import type { APIRoute } from 'astro';
import { supabaseAdmin } from '../../../../lib/supabase';

export const POST: APIRoute = async ({ params, redirect }) => {
  const { id } = params;
  if (!id) return new Response('Not found', { status: 404 });

  await supabaseAdmin.from('products').delete().eq('id', id);
  return redirect('/admin/produits');
};
