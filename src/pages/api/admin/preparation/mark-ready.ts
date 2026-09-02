import type { APIRoute } from 'astro';
import { createAuthClient, supabaseAdmin } from '../../../../lib/supabase';
import { logAdminAction } from '../../../../lib/audit';
import { sendOrderStatusEmail } from '../../../../lib/email';
import { isStaff } from '../../../../lib/roles';

export const POST: APIRoute = async ({ request, cookies }) => {
  const supabase = createAuthClient(request, cookies);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user || !isStaff(user)) {
    return new Response('Non autorisé', { status: 401 });
  }

  const body = (await request.json().catch(() => null)) as { orderId?: string } | null;
  const orderId = body?.orderId;
  if (!orderId) {
    return new Response(JSON.stringify({ error: 'orderId requis' }), { status: 400 });
  }

  const { data: order } = await supabaseAdmin
    .from('orders')
    .select('status, nom, societe, email, created_at')
    .eq('id', orderId)
    .single();

  if (!order) {
    return new Response(JSON.stringify({ error: 'Commande introuvable' }), { status: 404 });
  }

  // Already past this stage — nothing for this screen to do.
  if (order.status !== 'confirmee') {
    return new Response(JSON.stringify({ ok: true, status: order.status }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const { data: items } = await supabaseAdmin
    .from('order_items')
    .select('picked, product_name, quantity, unit, price_ht_snapshot, tva_rate_snapshot')
    .eq('order_id', orderId);

  const allPicked = (items ?? []).length > 0 && (items ?? []).every(i => i.picked);
  if (!allPicked) {
    return new Response(JSON.stringify({ error: 'Tous les articles ne sont pas encore préparés.' }), { status: 409 });
  }

  const { error } = await supabaseAdmin
    .from('orders')
    .update({ status: 'en_preparation' })
    .eq('id', orderId);

  if (error) {
    console.error('[api/preparation/mark-ready] update error:', error.message);
    return new Response(JSON.stringify({ error: error.message }), { status: 500 });
  }

  if (order.email) {
    const totalHt = (items ?? []).reduce((sum, it) => sum + Number(it.price_ht_snapshot ?? 0) * it.quantity, 0);
    const totalTva = (items ?? []).reduce(
      (sum, it) => sum + Number(it.price_ht_snapshot ?? 0) * it.quantity * Number(it.tva_rate_snapshot ?? 0.085),
      0
    );
    sendOrderStatusEmail({
      to: order.email,
      orderId,
      status: 'en_preparation',
      items: (items ?? []).map(it => ({ name: it.product_name, quantity: it.quantity, unit: it.unit })),
      totalHt,
      totalTva,
      orderDate: order.created_at,
    }).catch(err => console.error('[api/preparation/mark-ready] sendOrderStatusEmail threw:', err));
  }

  await logAdminAction({
    adminEmail: (user.email as string) ?? 'inconnu',
    action: 'commande.preparee',
    targetType: 'commande',
    targetId: orderId,
    targetLabel: order.societe ?? order.nom,
  });

  return new Response(JSON.stringify({ ok: true, status: 'en_preparation' }), {
    headers: { 'Content-Type': 'application/json' },
  });
};
