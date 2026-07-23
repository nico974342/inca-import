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

  // Atomic RPC: header + items + PUMP recalc + stock increment in one
  // transaction — a mid-way failure rolls everything back.
  const { data: receptionId, error: rpcErr } = await supabaseAdmin.rpc('reception_create', {
    p_supplier_name: supplierName,
    p_received_at:   receivedAt,
    p_notes:         notes,
    p_stock_applied: stockApplied,
    p_items: rows.map(r => ({
      product_id:   r.productId,
      quantity:     r.quantity,
      unit_cost_ht: r.unitCost,
    })),
  });

  if (rpcErr || !receptionId) {
    console.error('reception_create RPC error:', rpcErr);
    return Response.redirect(new URL('/admin/reception/new', request.url), 303);
  }

  await logAdminAction({
    adminEmail:   user.email ?? 'inconnu',
    action:       'reception.creation',
    targetType:   'reception',
    targetId:     receptionId as string,
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
