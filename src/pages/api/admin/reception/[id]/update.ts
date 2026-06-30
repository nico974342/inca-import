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

  // ── 1. Fetch current reception state ─────────────────────────────────
  const { data: oldRec, error: fetchErr } = await supabaseAdmin
    .from('stock_receptions')
    .select('supplier_name, stock_applied, stock_reception_items(product_id, quantity)')
    .eq('id', id)
    .single();

  if (fetchErr || !oldRec) {
    return new Response('Non trouvé', { status: 404 });
  }

  const oldItems: { product_id: string; quantity: number }[] =
    (oldRec as any).stock_reception_items ?? [];

  // ── 2. Reverse old stock if it was previously applied ─────────────────
  if ((oldRec as any).stock_applied) {
    for (const item of oldItems) {
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

  // ── 3. Replace items ──────────────────────────────────────────────────
  await supabaseAdmin.from('stock_reception_items').delete().eq('reception_id', id);

  await supabaseAdmin.from('stock_reception_items').insert(
    newRows.map(r => ({
      reception_id: id,
      product_id:   r.productId,
      quantity:     r.quantity,
      unit_cost_ht: r.unitCost,
    })),
  );

  // ── 4. Update reception header with new flags ─────────────────────────
  const todayStr     = new Date().toISOString().slice(0, 10);
  const newStockApplied = receivedAt >= todayStr;

  await supabaseAdmin
    .from('stock_receptions')
    .update({ supplier_name: supplierName, received_at: receivedAt, notes, stock_applied: newStockApplied })
    .eq('id', id);

  // ── 5. Recalculate PUMP from scratch for all affected products ────────
  // Union of old and new product IDs ensures products removed from the
  // reception also get their PUMP recalculated (excluding this reception now).
  const affectedIds = new Set<string>([
    ...oldItems.map(i => i.product_id),
    ...newRows.map(r => r.productId),
  ]);

  for (const productId of affectedIds) {
    const pump = await recalcPump(productId);
    await supabaseAdmin
      .from('products')
      .update({ prix_achat_moyen_ht: pump })
      .eq('id', productId);
  }

  // ── 6. Apply new stock if live ────────────────────────────────────────
  if (newStockApplied) {
    for (const row of newRows) {
      const { data: prod } = await supabaseAdmin
        .from('products')
        .select('stock_quantity')
        .eq('id', row.productId)
        .single();
      if (!prod) continue;
      const newQty = (prod.stock_quantity ?? 0) + row.quantity;
      await supabaseAdmin
        .from('products')
        .update({ stock_quantity: newQty, in_stock: newQty > 0 })
        .eq('id', row.productId);
    }
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
