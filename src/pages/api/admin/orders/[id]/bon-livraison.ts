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
    .select('id, nom, societe, email, telephone, created_at, bl_number')
    .eq('id', id)
    .single();

  if (!order) return new Response('Non trouvé', { status: 404 });

  const { data: items } = await supabaseAdmin
    .from('order_items')
    .select('product_name, quantity, unit, price_ht_snapshot, tva_rate_snapshot, products(sku, units_per_carton)')
    .eq('order_id', id);

  // Reuse existing BL number or generate and persist a new one
  let blNumber = (order as any).bl_number as string | null;
  if (!blNumber) {
    const { data: newBl } = await supabaseAdmin.rpc('next_bl_number');
    blNumber = newBl as string;
    await supabaseAdmin.from('orders').update({ bl_number: blNumber }).eq('id', id);
  }

  // Robust client lookup: email (trimmed) → nom → societe
  const CLIENT_SELECT = 'nom, societe, points_de_vente, livraison_rue, livraison_ville, livraison_code_postal, adresse_pdv, facturation_same, facturation_rue, facturation_code_postal, facturation_ville';
  let client: any = null;
  if (order.email) {
    const { data } = await supabaseAdmin.from('client_accounts').select(CLIENT_SELECT)
      .eq('email', order.email.trim()).maybeSingle();
    client = data;
  }
  if (!client && order.nom) {
    const { data } = await supabaseAdmin.from('client_accounts').select(CLIENT_SELECT)
      .ilike('nom', order.nom.trim()).maybeSingle();
    client = data;
  }
  if (!client && (order as any).societe) {
    const { data } = await supabaseAdmin.from('client_accounts').select(CLIENT_SELECT)
      .ilike('societe', (order as any).societe.trim()).maybeSingle();
    client = data;
  }

  const date = new Date(order.created_at).toLocaleDateString('fr-FR', {
    day: '2-digit', month: '2-digit', year: 'numeric',
  });

  const villePostal = [client?.livraison_code_postal, client?.livraison_ville].filter(Boolean).join(' ') || null;
  const addrParts   = [client?.livraison_rue, villePostal, 'La Réunion'].filter(Boolean);
  const clientAddress = addrParts.length > 1 ? addrParts.join(', ') : (client?.adresse_pdv ?? null);

  let clientFacturationAddress: string | null = null;
  if (client) {
    if (client.facturation_same) {
      clientFacturationAddress = clientAddress;
    } else {
      const factParts = [client.facturation_rue, client.facturation_code_postal, client.facturation_ville].filter(Boolean);
      clientFacturationAddress = factParts.length ? factParts.join(', ') : null;
    }
  }

  const buffer = await generatePDVDeliveryPDF(
    {
      name: client?.points_de_vente ?? order.nom,
      items: (items ?? []).map(it => ({
        product_name: it.product_name,
        quantity:     it.quantity,
        unit:         it.unit ?? null,
        price_ht:          (it as any).price_ht_snapshot         ?? null,
        sku:               (it as any).products?.sku             ?? null,
        tva_rate:          (it as any).tva_rate_snapshot         ?? 0.085,
        units_per_carton:  (it as any).products?.units_per_carton ?? null,
      })),
      client_nom:                  order.nom,
      client_societe:              order.societe ?? null,
      client_address:              clientAddress,
      client_facturation_address:  clientFacturationAddress,
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
