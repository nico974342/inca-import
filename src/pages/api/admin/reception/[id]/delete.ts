import type { APIRoute } from 'astro';
import { createAuthClient, supabaseAdmin } from '../../../../../lib/supabase';
import { logAdminAction } from '../../../../../lib/audit';
import { traiterFileCump } from '../../../../../lib/cump';
import { isAdmin } from '../../../../../lib/roles';
import { messageRefusStock, messageConflitSimultane, messageReceptionLiee, urlRefusStock } from '../../../../../lib/receptionErreur';
import { etatTransition, receptionLibreAutorisee } from '../../../../../lib/achatsTransition';

export const POST: APIRoute = async ({ params, request, cookies }) => {
  const supabase = createAuthClient(request, cookies);
  const { data: { user } } = await supabase.auth.getUser();

  // Réceptions fournisseur — hors du périmètre commercial, admin uniquement.
  if (!user || !isAdmin(user)) {
    return new Response('Non autorisé', { status: 401 });
  }

  // Garde SERVEUR de la transition : suspendu tant que le service n'est pas rouvert (migration appliquée sans réouverture, ou état invérifiable).
  if (!receptionLibreAutorisee(await etatTransition())) return Response.redirect(new URL('/admin/reception?err=suspendu', request.url), 303);

  const { id } = params;
  if (!id) return new Response('Non trouvé', { status: 404 });

  // Une réception rattachée à une COMMANDE ne se modifie ni ne se supprime ici : seule l'annulation motivée (page de la commande) régularise le stock et les
  // cumuls de façon cohérente et traçable. La base le refuse aussi ; ce renvoi explique pourquoi.
  const { data: liee } = await supabaseAdmin.from('stock_receptions').select('shipment_id').eq('id', id).maybeSingle();
  if (liee?.shipment_id) {
    const message = encodeURIComponent('Cette réception est rattachée à une commande : utilisez « Annuler cette réception » (motif obligatoire) sur la page de la commande.');
    return Response.redirect(new URL(`/admin/achats/${liee.shipment_id}?err=${message}`, request.url), 303);
  }

  // Fetch metadata for the audit log before the atomic delete
  const { data: rec, error: fetchErr } = await supabaseAdmin
    .from('stock_receptions')
    .select('supplier_name, stock_applied, stock_reception_items(product_id)')
    .eq('id', id)
    .single();

  if (fetchErr || !rec) return new Response('Non trouvé', { status: 404 });

  const productCount = new Set(
    ((rec as any).stock_reception_items ?? []).map((i: any) => i.product_id)
  ).size;

  // Atomic RPC: reverses applied stock, deletes the reception (cascades to
  // items) and recalculates PUMP — all in one transaction.
  const { error: rpcErr } = await supabaseAdmin.rpc('reception_delete', { p_reception_id: id });

  if (rpcErr) {
    console.error('reception_delete RPC error:', rpcErr);
    // Gel de la base (transition) : la base refuse l'exécution (permission denied, 42501) → message clair, rien n'a été enregistré.
    if (rpcErr?.code === '42501') return Response.redirect(new URL('/admin/reception?err=suspendu', request.url), 303);
    const refus = messageRefusStock(rpcErr) ?? messageConflitSimultane(rpcErr) ?? messageReceptionLiee(rpcErr);
    if (refus) return Response.redirect(new URL(urlRefusStock('/admin/reception', refus), request.url), 303);
    if (rpcErr.message?.includes('not found')) {
      return new Response('Non trouvé', { status: 404 });
    }
    return Response.redirect(new URL('/admin/reception', request.url), 303);
  }

  await logAdminAction({
    adminEmail:   user.email ?? 'inconnu',
    action:       'reception.suppression',
    targetType:   'reception',
    targetId:     id,
    targetLabel:  (rec as any).supplier_name,
    details: {
      stock_reversed:  (rec as any).stock_applied,
      products_count:  productCount,
    },
  });

  // Recalcul des marges (CUMP glissant) : demandes déposées par la base, traitées ici APRÈS l'opération. Ne lève jamais et ne change rien au résultat de l'opération.
  await traiterFileCump(supabaseAdmin);

  return Response.redirect(new URL('/admin/reception?success=deleted', request.url), 303);
};
