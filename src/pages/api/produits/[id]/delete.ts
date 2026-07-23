import type { APIRoute } from 'astro';
import { createAuthClient, supabaseAdmin } from '../../../../lib/supabase';
import { logAdminAction } from '../../../../lib/audit';

export const POST: APIRoute = async ({ params, request, cookies, redirect }) => {
  const supabase = createAuthClient(request, cookies);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user || user.user_metadata?.role === 'client') {
    return new Response('Non autorisé', { status: 401 });
  }

  const { id } = params;
  if (!id) return new Response('Not found', { status: 404 });

  const { data: product } = await supabaseAdmin
    .from('products')
    .select('name')
    .eq('id', id)
    .single();

  if (!product) return redirect('/admin/produits?delete_error=introuvable');

  const { error } = await supabaseAdmin.from('products').delete().eq('id', id);

  if (error) {
    console.error('[produits/delete] error:', error.code, error.message);
    // 23503 = foreign key violation (product referenced by receptions, carts…)
    const reason = error.code === '23503' ? 'reference' : 'erreur';
    return redirect(`/admin/produits?delete_error=${reason}`);
  }

  await logAdminAction({
    adminEmail: user.email ?? 'inconnu',
    action: 'produit.suppression',
    targetType: 'product',
    targetId: id,
    targetLabel: product.name,
  });

  return redirect('/admin/produits');
};
