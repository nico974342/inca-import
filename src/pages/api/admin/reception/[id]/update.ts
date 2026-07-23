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

  const form = await request.formData();

  const supplierName = (form.get('supplier_name') as string | null)?.trim() ?? '';
  const receivedAt   = (form.get('received_at') as string | null)?.trim() ?? '';
  const notes        = (form.get('notes') as string | null)?.trim() || null;

  const productIds = form.getAll('product_id[]') as string[];
  const quantities = form.getAll('quantity[]') as string[];
  const unitCosts  = form.getAll('unit_cost_ht[]') as string[];

  const editUrl = `/admin/reception/${id}/edit`;

  if (!supplierName || !receivedAt || productIds.length === 0) {
    return Response.redirect(new URL(editUrl, request.url), 303);
  }

  const newRows: { productId: string; quantity: number; unitCost: number }[] = [];
  for (let i = 0; i < productIds.length; i++) {
    const pid  = productIds[i]?.trim();
    const qty  = parseInt(quantities[i] ?? '0', 10);
    const cost = parseFloat(unitCosts[i] ?? '0');
    if (!pid || qty <= 0 || cost < 0) continue;
    newRows.push({ productId: pid, quantity: qty, unitCost: cost });
  }

  if (newRows.length === 0) {
    return Response.redirect(new URL(editUrl, request.url), 303);
  }

  const todayStr        = new Date().toISOString().slice(0, 10);
  const newStockApplied = receivedAt >= todayStr;

  // Atomic RPC: reverses previously-applied stock, replaces items, updates
  // the header, recalculates PUMP for old ∪ new products and applies the new
  // stock — all in one transaction. Raises if the reception doesn't exist.
  const { error: rpcErr } = await supabaseAdmin.rpc('reception_update', {
    p_reception_id:  id,
    p_supplier_name: supplierName,
    p_received_at:   receivedAt,
    p_notes:         notes,
    p_stock_applied: newStockApplied,
    p_items: newRows.map(r => ({
      product_id:   r.productId,
      quantity:     r.quantity,
      unit_cost_ht: r.unitCost,
    })),
  });

  if (rpcErr) {
    console.error('reception_update RPC error:', rpcErr);
    if (rpcErr.message?.includes('not found')) {
      return new Response('Non trouvé', { status: 404 });
    }
    return Response.redirect(new URL(editUrl, request.url), 303);
  }

  await logAdminAction({
    adminEmail:   user.email ?? 'inconnu',
    action:       'reception.modification',
    targetType:   'reception',
    targetId:     id,
    targetLabel:  supplierName,
    details: {
      received_at:    receivedAt,
      historique:     !newStockApplied,
      products_count: newRows.length,
      total_units:    newRows.reduce((s, r) => s + r.quantity, 0),
      total_cost_ht:  newRows.reduce((s, r) => s + r.quantity * r.unitCost, 0),
    },
  });

  return Response.redirect(
    new URL(`/admin/reception?success=updated`, request.url),
    303,
  );
};
