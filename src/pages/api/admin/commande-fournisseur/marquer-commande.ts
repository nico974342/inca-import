import type { APIRoute } from 'astro';
import { createAuthClient, supabaseAdmin } from '../../../../lib/supabase';
import { sanitizeText } from '../../../../lib/sanitize';
import { logAdminAction } from '../../../../lib/audit';
import { isAdmin } from '../../../../lib/roles';

// Point 7 de la demande "commande-fournisseur v2" : relie la proposition à
// une commande réellement passée. Réutilise le module Transit (shipments +
// shipment_items, statut 'commande') plutôt que d'inventer un système
// parallèle — une fois créée ici, l'expédition est une commande fournisseur
// active comme une autre : elle apparaît sur /admin/transit, et surtout ses
// quantités sont désormais nettes des futures suggestions de cette page
// (voir arrivalsByProduct dans commande-fournisseur.astro), donc un rechargement
// ne propose plus une commande identique en ignorant celle-ci. Copier le
// texte d'une commande (bouton "Copier") ne passe jamais par cette route —
// seule cette action explicite écrit en base.
//
// Idempotence : le client génère idempotency_key UNE FOIS par bouton (pas à
// chaque clic) — un double-clic ou une requête rejouée avec la même clé
// retrouve l'expédition déjà créée au lieu d'en insérer une seconde. Voir
// l'index unique partiel sur shipments.idempotency_key.

export const POST: APIRoute = async ({ request, cookies }) => {
  const supabase = createAuthClient(request, cookies);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user || !isAdmin(user)) {
    return new Response('Non autorisé', { status: 401 });
  }

  let body: {
    supplier_name?: string;
    supplier_id?: string | null;
    items?: { product_id: string; quantity: number; unit_cost_ht: number | null }[];
    idempotency_key?: string;
  };
  try {
    body = await request.json();
  } catch {
    return new Response('JSON invalide', { status: 400 });
  }

  const supplierName = sanitizeText(body.supplier_name ?? '', 120).trim();
  const items = (body.items ?? []).filter(it =>
    typeof it.product_id === 'string' && it.product_id.length > 0 &&
    Number.isFinite(it.quantity) && it.quantity > 0,
  );
  const idempotencyKey = typeof body.idempotency_key === 'string' && body.idempotency_key.length > 0
    ? body.idempotency_key
    : null;
  // Identifiant fournisseur déjà résolu côté page (supplierByProduct /
  // resolveProductSupplier) — ni deviné ni re-matché ici, juste relayé tel
  // quel : cette route ne connaît pas les autres fournisseurs candidats.
  const supplierId = typeof body.supplier_id === 'string' && body.supplier_id.length > 0
    ? body.supplier_id
    : null;

  if (!supplierName || items.length === 0) {
    return new Response('Fournisseur ou lignes manquantes', { status: 400 });
  }

  if (idempotencyKey) {
    const { data: existing } = await supabaseAdmin
      .from('shipments')
      .select('id')
      .eq('idempotency_key', idempotencyKey)
      .maybeSingle();
    if (existing) {
      // Déjà traité par une tentative précédente (double-clic, requête
      // rejouée) : on renvoie la même expédition plutôt que d'en recréer une.
      return new Response(JSON.stringify({ ok: true, shipment_id: existing.id, duplicate: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
  }

  const { data: created, error: insErr } = await supabaseAdmin
    .from('shipments')
    .insert({
      supplier_name: supplierName,
      supplier_id: supplierId,
      status: 'commande',
      notes: 'Généré depuis /admin/commande-fournisseur',
      idempotency_key: idempotencyKey,
    })
    .select('id')
    .single();

  if (insErr) {
    // Conflit sur idempotency_key : une requête concurrente a gagné la
    // course entre la lecture ci-dessus et cet insert — même traitement que
    // "déjà existant", pas une erreur pour l'utilisateur.
    if (insErr.code === '23505' && idempotencyKey) {
      const { data: raced } = await supabaseAdmin
        .from('shipments')
        .select('id')
        .eq('idempotency_key', idempotencyKey)
        .maybeSingle();
      if (raced) {
        return new Response(JSON.stringify({ ok: true, shipment_id: raced.id, duplicate: true }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
    }
    console.error('[commande-fournisseur] création expédition:', insErr.message);
    return new Response('Échec de la création', { status: 500 });
  }
  if (!created) {
    return new Response('Échec de la création', { status: 500 });
  }

  const rows = items.map(it => ({
    shipment_id: created.id,
    product_id: it.product_id,
    quantity: Math.floor(it.quantity),
    unit_cost_ht: it.unit_cost_ht != null && Number.isFinite(it.unit_cost_ht) ? it.unit_cost_ht : null,
  }));

  const { error: itemsErr } = await supabaseAdmin.from('shipment_items').insert(rows);
  if (itemsErr) {
    console.error('[commande-fournisseur] lignes expédition:', itemsErr.message);
    // En-tête sans lignes est pire que rien : on l'annule plutôt que de
    // laisser une commande fantôme sans contenu.
    await supabaseAdmin.from('shipments').delete().eq('id', created.id);
    return new Response('Échec de l’enregistrement des lignes', { status: 500 });
  }

  // Ces lignes ne sont plus un brouillon en attente : elles viennent de
  // devenir une vraie commande. Les retirer évite de les faire réapparaître
  // pré-remplies sur un produit qui n'a plus rien "en cours de décision".
  const productIds = items.map(it => it.product_id);
  await supabaseAdmin
    .from('commande_fournisseur_drafts')
    .delete()
    .eq('admin_email', user.email ?? '')
    .in('product_id', productIds);

  await logAdminAction({
    adminEmail: user.email ?? 'inconnu',
    action: 'commande_fournisseur.marquer_commande',
    targetType: 'shipment',
    targetId: created.id,
    targetLabel: supplierName,
    details: { lignes: rows.length, total_cartons: rows.reduce((s, r) => s + r.quantity, 0) },
  });

  return new Response(JSON.stringify({ ok: true, shipment_id: created.id }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
};
