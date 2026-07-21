import type { APIRoute } from 'astro';
import { createAuthClient, supabaseAdmin } from '../../../../../lib/supabase';
import { logAdminAction } from '../../../../../lib/audit';
import { recalcPump } from '../../../../../lib/pump';

export const POST: APIRoute = async ({ params, request, cookies }) => {
  const supabase = createAuthClient(request, cookies);
  const { data: { user } } = await supabase.auth.getUser();

  if (!user || user.user_metadata?.role === 'client') {
    return new Response('Non autorisé', { status: 401 });
  }

  const { id } = params;
  if (!id) return new Response('Non trouvé', { status: 404 });

  // Fetch reception state before deleting
  const { data: rec, error: fetchErr } = await supabaseAdmin
    .from('stock_receptions')
    .select('supplier_name, stock_applied, stock_reception_items(product_id, quantity)')
    .eq('id', id)
    .single();

  if (fetchErr || !rec) return new Response('Non trouvé', { status: 404 });

  const items: { product_id: string; quantity: number }[] =
    (rec as any).stock_reception_items ?? [];

  // Reverse stock if this reception had applied it
  if ((rec as any).stock_applied) {
    for (const item of items) {
      const { data: prod } = await supabaseAdmin
        .from('products')
        .select('stock_quantity')
        .eq('id', item.product_id)
        .single();
      if (!prod) continue;
      const restoredQty = Math.max(0, (prod.stock_quantity ?? 0) - item.quantity);
      await supabaseAdmin
        .from('products')
        .update({ stock_quantity: restoredQty, in_stock: restoredQty > 0 })
        .eq('id', item.product_id);
    }
  }

  // Collect affected product IDs before the cascade delete removes items
  const affectedIds = [...new Set(items.map(i => i.product_id))];

  // Delete reception — CASCADE removes stock_reception_items automatically
  await supabaseAdmin.from('stock_receptions').delete().eq('id', id);

  // Recalculate PUMP from scratch for every affected product
  for (const productId of affectedIds) {
    const pump = await recalcPump(productId);
    await supabaseAdmin
      .from('products')
      .update({ prix_achat_moyen_ht: pump })
      .eq('id', productId);
  }

  await logAdminAction({
    adminEmail:   user.email ?? 'inconnu',
    action:       'reception.suppression',
    targetType:   'reception',
    targetId:     id,
    targetLabel:  (rec as any).supplier_name,
    details: {
      stock_reversed:  (rec as any).stock_applied,
      products_count:  affectedIds.length,
    },
  });

  return Response.redirect(new URL('/admin/reception?success=deleted', request.url), 303);
};
