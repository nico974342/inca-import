import type { APIRoute } from 'astro';
import { createAuthClient, supabaseAdmin } from '../../../../lib/supabase';
import { logAdminAction } from '../../../../lib/audit';
import { todayReunionISO } from '../../../../lib/datetime';
import { isAdmin } from '../../../../lib/roles';
import { etatTransition, receptionLibreAutorisee } from '../../../../lib/achatsTransition';
import { matchSupplierName } from '../../../../lib/constants';
import { parseDlc } from '../../../../lib/dlc';

export const POST: APIRoute = async ({ request, cookies }) => {
  const supabase = createAuthClient(request, cookies);
  const { data: { user } } = await supabase.auth.getUser();

  // Réceptions fournisseur — hors du périmètre commercial, admin uniquement.
  if (!user || !isAdmin(user)) {
    return new Response('Non autorisé', { status: 401 });
  }

  // Garde SERVEUR de la transition : suspendu tant que le service n'est pas rouvert (migration appliquée sans réouverture, ou état invérifiable).
  if (!receptionLibreAutorisee(await etatTransition())) return Response.redirect(new URL('/admin/reception?err=suspendu', request.url), 303);

  const form = await request.formData();

  // Une réception issue d'une COMMANDE fournisseur passe EXCLUSIVEMENT par l'enregistrement atomique (page « Enregistrer une réception » de la commande) :
  // réception + lignes + stock + PUMP + cumuls + rattachement + état en UNE transaction, avec clé d'idempotence. Ce chemin historique mettait à jour les
  // cumuls APRÈS COUP, hors transaction (un échec laissait un stock augmenté sans cumul) : il ne sert plus qu'aux réceptions hors commande.
  const commandeId = (form.get('shipment_id') as string | null)?.trim() || null;
  if (commandeId) return Response.redirect(new URL(`/admin/achats/${encodeURIComponent(commandeId)}/reception`, request.url), 303);

  const supplierName = (form.get('supplier_name') as string | null)?.trim() ?? '';
  const receivedAt   = (form.get('received_at') as string | null)?.trim() ?? '';
  const notes        = (form.get('notes') as string | null)?.trim() || null;

  const productIds = form.getAll('product_id[]') as string[];
  const quantities = form.getAll('quantity[]') as string[];
  const unitCosts  = form.getAll('unit_cost_ht[]') as string[];
  const dlcs       = form.getAll('dlc[]') as string[];

  if (!supplierName || !receivedAt || productIds.length === 0) {
    return Response.redirect(new URL('/admin/reception/new', request.url), 303);
  }

  const rows: { productId: string; quantity: number; unitCost: number; dlc: string | null }[] = [];
  for (let i = 0; i < productIds.length; i++) {
    const pid  = productIds[i]?.trim();
    const qty  = parseInt(quantities[i] ?? '0', 10);
    const cost = parseFloat(unitCosts[i] ?? '0');
    if (!pid || qty <= 0 || cost < 0) continue;
    rows.push({ productId: pid, quantity: qty, unitCost: cost, dlc: parseDlc(dlcs[i]) });
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
      dlc:          r.dlc,
    })),
  });

  if (rpcErr || !receptionId) {
    console.error('reception_create RPC error:', rpcErr);
    // Gel de la base (transition) : la base refuse l'exécution (permission denied, 42501) → message clair, rien n'a été enregistré.
    if (rpcErr?.code === '42501') return Response.redirect(new URL('/admin/reception?err=suspendu', request.url), 303);
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
