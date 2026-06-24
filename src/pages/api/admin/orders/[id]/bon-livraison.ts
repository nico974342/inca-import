import type { APIRoute } from 'astro';
import { createAuthClient, supabaseAdmin } from '../../../../../lib/supabase';
import { generatePDVDeliveryPDF } from '../../../../../lib/pdf';

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
    .select('id, nom, societe, email, created_at')
    .eq('id', id)
    .single();

  if (!order) return new Response('Non trouvé', { status: 404 });

  const [{ data: items }, { data: client }, { data: blNumber }] = await Promise.all([
    supabaseAdmin
      .from('order_items')
      .select('product_name, quantity, unit, products(price_ht, sku)')
      .eq('order_id', id),
    supabaseAdmin
      .from('client_accounts')
      .select('nom, societe, points_de_vente, livraison_rue, livraison_ville, livraison_code_postal, adresse_pdv')
      .eq('email', order.email)
      .maybeSingle(),
    supabaseAdmin.rpc('next_bl_number'),
  ]);

  const date = new Date(order.created_at).toLocaleDateString('fr-FR', {
    day: '2-digit', month: '2-digit', year: 'numeric',
  });

  const villePostal = [client?.livraison_code_postal, client?.livraison_ville].filter(Boolean).join(' ') || null;
  const addrParts   = [client?.livraison_rue, villePostal, 'La Réunion'].filter(Boolean);
  const clientAddress = addrParts.length > 1 ? addrParts.join(', ') : (client?.adresse_pdv ?? null);

  const buffer = await generatePDVDeliveryPDF(
    {
      name: client?.points_de_vente ?? order.nom,
      items: (items ?? []).map(it => ({
        product_name: it.product_name,
        quantity:     it.quantity,
        unit:         it.unit ?? null,
        price_ht:     (it as any).products?.price_ht ?? null,
        sku:          (it as any).products?.sku       ?? null,
      })),
      client_nom:     order.nom,
      client_societe: order.societe ?? null,
      client_address: clientAddress,
    },
    blNumber as string,
    date,
  );

  return new Response(buffer, {
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `inline; filename="${blNumber}.pdf"`,
      'Content-Length': String(buffer.length),
    },
  });
};
