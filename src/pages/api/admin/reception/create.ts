import type { APIRoute } from 'astro';
import { createAuthClient, supabaseAdmin } from '../../../../lib/supabase';
import { logAdminAction } from '../../../../lib/audit';
import { recalcPump } from '../../../../lib/pump';

export const POST: APIRoute = async ({ request, cookies }) => {
  const supabase = createAuthClient(request, cookies);
  const { data: { user } } = await supabase.auth.getUser();

  if (!user || user.user_metadata?.role === 'client') {
    return new Response('Non autorisé', { status: 401 });
  }

  const form = await request.formData();

  const supplierName = (form.get('supplier_name') as string | null)?.trim() ?? '';
  const receivedAt   = (form.get('received_at') as string | null)?.trim() ?? '';
  const notes        = (form.get('notes') as string | null)?.trim() || null;

  const productIds = form.getAll('product_id[]') as string[];
  const quantities = form.getAll('quantity[]') as string[];
  const unitCosts  = form.getAll('unit_cost_ht[]') as string[];

  if (!supplierName || !receivedAt || productIds.length === 0) {
    return Response.redirect(new URL('/admin/reception/new', request.url), 303);
  }

  const rows: { productId: string; quantity: number; unitCost: number }[] = [];
  for (let i = 0; i < productIds.length; i++) {
    const pid  = productIds[i]?.trim();
    const qty  = parseInt(quantities[i] ?? '0', 10);
    const cost = parseFloat(unitCosts[i] ?? '0');
    if (!pid || qty <= 0 || cost < 0) continue;
    rows.push({ productId: pid, quantity: qty, unitCost: cost });
  }

  if (rows.length === 0) {
    return Response.redirect(new URL('/admin/reception/new', request.url), 303);
  }

  // Lexicographic YYYY-MM-DD comparison is safe for date-only strings.
  const todayStr    = new Date().toISOString().slice(0, 10);
  const stockApplied = receivedAt >= todayStr; // today/future → also update stock

  // Insert reception header with flags
  const { data: reception, error: recErr } = await supabaseAdmin
    .from('stock_receptions')
    .insert({ supplier_name: supplierName, received_at: receivedAt, notes, stock_applied: stockApplied })
    .select('id')
    .single();

  if (recErr || !reception) {
    console.error('reception insert error:', recErr);
    return Response.redirect(new URL('/admin/reception/new', request.url), 303);
  }

  // Insert line items
  const { error: itemErr } = await supabaseAdmin
    .from('stock_reception_items')
    .insert(rows.map(r => ({
      reception_id: reception.id,
      product_id:   r.productId,
      quantity:     r.quantity,
      unit_cost_ht: r.unitCost,
    })));

  if (itemErr) {
    console.error('reception items insert error:', itemErr);
    await supabaseAdmin.from('stock_receptions').delete().eq('id', reception.id);
    return Response.redirect(new URL('/admin/reception/new', request.url), 303);
  }

  // Recalculate PUMP from scratch for every product in this reception.
  // Items are already in DB, so recalcPump() sees the full picture.
  // PUMP is always recalculated regardless of date (historical receptions count for cost tracking).
  for (const row of rows) {
    const pump = await recalcPump(row.productId);
    await supabaseAdmin
      .from('products')
      .update({ prix_achat_moyen_ht: pump })
      .eq('id', row.productId);
  }

  // Apply stock increment only for live (today/future) receptions
  if (stockApplied) {
    for (const row of rows) {
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
    action:       'reception.creation',
    targetType:   'reception',
    targetId:     reception.id,
    targetLabel:  supplierName,
    details: {
      received_at:    receivedAt,
      historique:     !stockApplied,
      products_count: rows.length,
      total_units:    rows.reduce((s, r) => s + r.quantity, 0),
      total_cost_ht:  rows.reduce((s, r) => s + r.quantity * r.unitCost, 0),
    },
  });

  return Response.redirect(
    new URL(`/admin/reception?success=${stockApplied ? '1' : 'historical'}`, request.url),
    303,
  );
};
