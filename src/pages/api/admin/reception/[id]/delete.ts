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

  // Fetch metadata for the audit log before the atomic delete
  const { data: rec, error: fetchErr } = await supabaseAdmin
    .from('stock_receptions')
    .select('supplier_name, stock_applied, stock_reception_items(product_id)')
    .eq('id', id)
    .single();

  if (fetchErr || !rec) return new Response('Non trouvé', { status: 404 });

  const productCount = new Set(
    ((rec as any).stock_reception_items ?? []).map((i: any) => i.product_id)
  ).size;

  // Atomic RPC: reverses applied stock, deletes the reception (cascades to
  // items) and recalculates PUMP — all in one transaction.
  const { error: rpcErr } = await supabaseAdmin.rpc('reception_delete', { p_reception_id: id });

  if (rpcErr) {
    console.error('reception_delete RPC error:', rpcErr);
    if (rpcErr.message?.includes('not found')) {
      return new Response('Non trouvé', { status: 404 });
    }
    return Response.redirect(new URL('/admin/reception', request.url), 303);
  }

  await logAdminAction({
    adminEmail:   user.email ?? 'inconnu',
    action:       'reception.suppression',
    targetType:   'reception',
    targetId:     id,
    targetLabel:  (rec as any).supplier_name,
    details: {
      stock_reversed:  (rec as any).stock_applied,
      products_count:  productCount,
    },
  });

  return Response.redirect(new URL('/admin/reception?success=deleted', request.url), 303);
};
