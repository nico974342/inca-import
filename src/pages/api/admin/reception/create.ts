import type { APIRoute } from 'astro';
import { createAuthClient, supabaseAdmin } from '../../../../lib/supabase';
import { logAdminAction } from '../../../../lib/audit';
import { todayReunionISO } from '../../../../lib/datetime';
import { isAdmin } from '../../../../lib/roles';
import { matchSupplierName } from '../../../../lib/constants';

export const POST: APIRoute = async ({ request, cookies }) => {
  const supabase = createAuthClient(request, cookies);
  const { data: { user } } = await supabase.auth.getUser();

  // Réceptions fournisseur — hors du périmètre commercial, admin uniquement.
  if (!user || !isAdmin(user)) {
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
  // "Aujourd'hui" doit s'entendre heure de La Réunion, pas UTC (serveur) —
  // sinon une réception historique saisie entre 0h et 4h du matin se voit
  // appliquer le stock comme si elle était du jour.
  const todayStr    = todayReunionISO();
  const stockApplied = receivedAt >= todayStr; // today/future → also update stock

  // Identifiant fournisseur stable : résolu ici (casse/espaces normalisés),
  // jamais deviné au-delà d'une correspondance certaine — voir
  // matchSupplierName. Un texte ambigu ou inconnu reste supplier_id NULL et
  // remonte comme "à rapprocher" sur /admin/fournisseurs, sans bloquer la
  // réception (le texte saisi reste la trace, snapshot).
  const { data: suppliersForMatch } = await supabaseAdmin.from('suppliers').select('id, name');
  const supplierMatch = matchSupplierName(supplierName, suppliersForMatch ?? []);

  // Atomic RPC: header + items + PUMP recalc + stock increment in one
  // transaction — a mid-way failure rolls everything back.
  const { data: receptionId, error: rpcErr } = await supabaseAdmin.rpc('reception_create', {
    p_supplier_name: supplierName,
    p_supplier_id:   supplierMatch.supplierId,
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

  // Réception issue d'une expédition en transit : chaque ligne reçue
  // s'accumule sur shipment_items.received_quantity plutôt que de clore
  // l'expédition entière d'un coup — une réception qui ne couvre qu'une
  // partie des lignes (ou une quantité inférieure à celle commandée) laisse
  // le reliquat visible et l'expédition active, au lieu de le faire
  // disparaître silencieusement. Le statut ne passe à « Réceptionné » que
  // lorsque toutes les lignes sont intégralement couvertes. Non bloquant —
  // le stock est déjà appliqué et validé, et refuser la réception pour un
  // statut de suivi serait pire que de la signaler.
  const shipmentId = (form.get('shipment_id') as string | null)?.trim() || null;
  let shipmentWarning = false;
  if (shipmentId) {
    const { data: shipmentItems, error: fetchErr } = await supabaseAdmin
      .from('shipment_items')
      .select('id, product_id, quantity, received_quantity')
      .eq('shipment_id', shipmentId);

    if (fetchErr || !shipmentItems) {
      shipmentWarning = true;
      console.error('[reception] lecture lignes expédition échouée:', shipmentId, fetchErr?.message);
    } else {
      const receivedByProduct = new Map(rows.map(r => [r.productId, r.quantity]));
      let allFulfilled = true;
      for (const item of shipmentItems) {
        const justReceived = receivedByProduct.get(item.product_id) ?? 0;
        const newReceived = (item.received_quantity ?? 0) + justReceived;
        if (justReceived > 0) {
          const { error: itemErr } = await supabaseAdmin
            .from('shipment_items')
            .update({ received_quantity: newReceived })
            .eq('id', item.id);
          if (itemErr) {
            shipmentWarning = true;
            console.error('[reception] mise à jour received_quantity échouée:', item.id, itemErr.message);
          }
        }
        if (newReceived < item.quantity) allFulfilled = false;
      }

      if (allFulfilled) {
        const { error: shipErr } = await supabaseAdmin
          .from('shipments')
          .update({ status: 'receptionne' })
          .eq('id', shipmentId);
        if (shipErr) {
          shipmentWarning = true;
          console.error('[reception] passage en receptionne échoué:', shipmentId, shipErr.message);
        }
      }
    }
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
      shipment_id:    shipmentId,
    },
  });

  if (shipmentWarning) {
    return Response.redirect(
      new URL('/admin/reception?success=1&shipment_warning=1', request.url),
      303,
    );
  }

  return Response.redirect(
    new URL(`/admin/reception?success=${stockApplied ? '1' : 'historical'}`, request.url),
    303,
  );
};
