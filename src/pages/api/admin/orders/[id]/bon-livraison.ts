import type { APIRoute } from 'astro';
import { createAuthClient, supabaseAdmin } from '../../../../../lib/supabase';
import { generatePDVDeliveryPDF } from '../../../../../lib/pdf';
import { findClientByEmail } from '../../../../../lib/clients';
import { formatDateReunion } from '../../../../../lib/datetime';
import { isStaff } from '../../../../../lib/roles';
import { fetchBlsDesCommandes, lireBlOriginal } from '../../../../../lib/blSignatures';
import { estUuid } from '../../../../../lib/blCommande';

export const GET: APIRoute = async ({ params, request, cookies }) => {
  const supabase = createAuthClient(request, cookies);
  const { data: { user } } = await supabase.auth.getUser();

  if (!user || !isStaff(user)) {
    return new Response('Non autorisé', { status: 401 });
  }

  const { id } = params;
  if (!id || !estUuid(id)) return new Response('Non trouvé', { status: 404 });

  // BL enregistré pour cette commande (système commun Commandes / Livraison) : on sert l'archive FIGÉE, jamais régénérée
  // d'après la commande, et sans aucune écriture (ni numéro, ni e-mail).
  const enregistres = (await fetchBlsDesCommandes([id])).get(id) ?? [];
  if (enregistres.length > 0) {
    const bl = await lireBlOriginal(enregistres[0].id);
    if (bl) {
      return new Response(bl.buffer, {
        headers: {
          'Content-Type': 'application/pdf',
          'Content-Disposition': `inline; filename="${bl.blNumber}.pdf"`,
          'Content-Length': String(bl.buffer.length),
          'Cache-Control': 'private, no-store',
        },
      });
    }
  }

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

  // ANCIEN BL (numéro porté par la commande, signé sur papier et archivé dans Pennylane) : reconstruit à la volée comme avant,
  // sans aucune écriture. Une commande SANS BL n'en reçoit plus un par simple lien (GET) : la création est une action
  // explicite (« Générer le BL », POST /api/admin/orders/[id]/bl) — un clic, un rafraîchissement ou un double clic ne consomme jamais de numéro.
  const blNumber = (order as any).bl_number as string | null;
  if (!blNumber) {
    return new Response(null, { status: 303, headers: { Location: `/admin/commandes?bl_err=${encodeURIComponent("Aucun BL établi pour cette commande : utilisez « Générer le BL » sur la fiche commande.")}&ouvrir=${id}#cmd-${id}` } });
  }

  // Robust client lookup: email (normalized, case-insensitive) → nom → societe
  const CLIENT_SELECT = 'nom, societe, points_de_vente, livraison_rue, livraison_ville, livraison_code_postal, adresse_pdv, facturation_same, facturation_rue, facturation_code_postal, facturation_ville';
  let client: any = await findClientByEmail(order.email, CLIENT_SELECT);
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

  const date = formatDateReunion(order.created_at);

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
