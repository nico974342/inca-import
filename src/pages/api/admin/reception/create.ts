import type { APIRoute } from 'astro';
import { createAuthClient, supabaseAdmin } from '../../../../lib/supabase';
import { logAdminAction } from '../../../../lib/audit';

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

  const productIds  = form.getAll('product_id[]') as string[];
  const quantities  = form.getAll('quantity[]') as string[];
  const unitCosts   = form.getAll('unit_cost_ht[]') as string[];

  if (!supplierName || !receivedAt || productIds.length === 0) {
    return Response.redirect(new URL('/admin/reception/new', request.url), 303);
  }

  // Validate all rows
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

  // Insert reception header
  const { data: reception, error: recErr } = await supabaseAdmin
    .from('stock_receptions')
    .insert({ supplier_name: supplierName, received_at: receivedAt, notes })
    .select('id')
    .single();

  if (recErr || !reception) {
    console.error('reception insert error:', recErr);
    return Response.redirect(new URL('/admin/reception/new', request.url), 303);
  }

  // Insert line items
  const itemRows = rows.map(r => ({
    reception_id:  reception.id,
    product_id:    r.productId,
    quantity:      r.quantity,
    unit_cost_ht:  r.unitCost,
  }));

  const { error: itemErr } = await supabaseAdmin
    .from('stock_reception_items')
    .insert(itemRows);

  if (itemErr) {
    console.error('reception items insert error:', itemErr);
    await supabaseAdmin.from('stock_receptions').delete().eq('id', reception.id);
    return Response.redirect(new URL('/admin/reception/new', request.url), 303);
  }

  // Compare receivedAt (YYYY-MM-DD) against today's server date.
  // Both are plain date strings so lexicographic comparison is correct.
  const todayStr = new Date().toISOString().slice(0, 10);
  const isLive   = receivedAt >= todayStr; // today or future → apply stock + PUMP

  if (isLive) {
    // For each product: fetch current state, compute new PUMP, update stock
    for (const row of rows) {
      const { data: prod } = await supabaseAdmin
        .from('products')
        .select('stock_quantity, prix_achat_moyen_ht')
        .eq('id', row.productId)
        .single();

      if (!prod) continue;

      const oldQty  = prod.stock_quantity ?? 0;
      const oldPump = prod.prix_achat_moyen_ht;

      let newPump: number;
      if (oldQty <= 0 || oldPump == null) {
        newPump = row.unitCost;
      } else {
        newPump = ((oldQty * oldPump) + (row.quantity * row.unitCost)) / (oldQty + row.quantity);
      }

      const newQty = oldQty + row.quantity;

      await supabaseAdmin
        .from('products')
        .update({
          stock_quantity:      newQty,
          prix_achat_moyen_ht: Math.round(newPump * 10000) / 10000,
        })
        .eq('id', row.productId);
    }
  }
  // Backdated receptions (received_at < today): records saved for history only,
  // no stock_quantity or prix_achat_moyen_ht change.

  // Audit log
  await logAdminAction({
    adminEmail:   user.email ?? 'inconnu',
    action:       'reception.creation',
    targetType:   'reception',
    targetId:     reception.id,
    targetLabel:  supplierName,
    details: {
      received_at:    receivedAt,
      historique:     !isLive,
      products_count: rows.length,
      total_units:    rows.reduce((s, r) => s + r.quantity, 0),
      total_cost_ht:  rows.reduce((s, r) => s + r.quantity * r.unitCost, 0),
    },
  });

  const successParam = isLive ? 'success=1' : 'success=historical';
  return Response.redirect(new URL(`/admin/reception?${successParam}`, request.url), 303);
};
