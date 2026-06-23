import type { APIRoute } from 'astro';
import { createAuthClient, supabaseAdmin } from '../../../../../lib/supabase';
import { generateInvoicePDF } from '../../../../../lib/pdf';

export const GET: APIRoute = async ({ params, request, cookies }) => {
  const supabase = createAuthClient(request, cookies);
  const { data: { user } } = await supabase.auth.getUser();

  if (!user || user.user_metadata?.role === 'client') {
    return new Response('Non autorisé', { status: 401 });
  }

  const { id } = params;
  if (!id) return new Response('Non trouvé', { status: 404 });

  const { data: order } = await supabaseAdmin
    .from('orders')
    .select('*')
    .eq('id', id)
    .single();

  if (!order) return new Response('Non trouvé', { status: 404 });

  const { data: items } = await supabaseAdmin
    .from('order_items')
    .select('product_name, quantity, unit, products(price_ht)')
    .eq('order_id', id);

  const { data: clientAcc } = await supabaseAdmin
    .from('client_accounts')
    .select('points_de_vente')
    .eq('email', order.email)
    .maybeSingle();

  let totalHT = 0;
  const pdfItems = (items ?? []).map(item => {
    const price_ht = (item.products as any)?.price_ht ?? null;
    if (price_ht != null) totalHT += Number(price_ht) * item.quantity;
    return {
      product_name: item.product_name,
      quantity: item.quantity,
      unit: item.unit ?? null,
      price_ht: price_ht != null ? Number(price_ht) : null,
    };
  });

  const date = new Date(order.created_at).toLocaleDateString('fr-FR', {
    day: '2-digit', month: '2-digit', year: 'numeric',
  });

  const buffer = await generateInvoicePDF({
    id: order.id,
    nom: order.nom,
    societe: order.societe ?? null,
    email: order.email,
    telephone: order.telephone ?? null,
    points_de_vente: clientAcc?.points_de_vente ?? null,
    notes: order.notes ?? null,
    items: pdfItems,
    totalHT,
    date,
  });

  return new Response(buffer, {
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `inline; filename="accuse-reception-${order.id.slice(0, 8).toUpperCase()}.pdf"`,
      'Content-Length': String(buffer.length),
    },
  });
};
