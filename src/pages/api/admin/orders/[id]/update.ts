import type { APIRoute } from 'astro';
import { createAuthClient, supabaseAdmin } from '../../../../../lib/supabase';
import { logAdminAction } from '../../../../../lib/audit';
import { findClientByEmail, fetchClientPriceOverrides, resolveClientPrice } from '../../../../../lib/clients';
import { isStaff } from '../../../../../lib/roles';
import { isOrderEditable } from '../../../../../lib/constants';
import { updateOrderChecked, type OrderLineInput } from '../../../../../lib/stock';

export const POST: APIRoute = async ({ params, request, cookies }) => {
  const supabase = createAuthClient(request, cookies);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user || !isStaff(user)) {
    return new Response('Non autorisé', { status: 401 });
  }

  const { id } = params;
  if (!id) return new Response('Non trouvé', { status: 404 });

  const redirectTo = (path: string) => Response.redirect(new URL(path, request.url).toString(), 303);

  const { data: order } = await supabaseAdmin
    .from('orders')
    .select('status, nom, societe, email')
    .eq('id', id)
    .single();

  if (!order) return redirectTo('/admin/commandes');
  if (!isOrderEditable(order.status)) return redirectTo('/admin/commandes?edit_error=trop_tard');

  const form = await request.formData();
  const productIds = form.getAll('product_id[]') as string[];
  const quantities  = form.getAll('quantity[]').map(v => parseInt(v as string, 10));

  // Collapse into product_id -> total quantity (defends against accidental
  // duplicate lines for the same product from the client).
  const submitted = new Map<string, number>();
  for (let i = 0; i < productIds.length; i++) {
    const pid = productIds[i];
    const qty = quantities[i];
    if (!pid || !Number.isFinite(qty) || qty <= 0) continue;
    submitted.set(pid, (submitted.get(pid) ?? 0) + qty);
  }

  if (submitted.size === 0) return redirectTo(`/admin/commandes/${id}/edit?error=empty`);

  const { data: currentItems } = await supabaseAdmin
    .from('order_items')
    .select('id, product_id, product_name, quantity')
    .eq('order_id', id);

  const currentByProduct = new Map(
    (currentItems ?? []).filter(it => it.product_id).map(it => [it.product_id as string, it])
  );

  const { data: productsData } = await supabaseAdmin
    .from('products')
    .select('id, name, unit, price_ht, tva_rate, prix_achat_moyen_ht')
    .in('id', [...submitted.keys()]);
  const productMap = new Map((productsData ?? []).map(p => [p.id, p]));

  // New lines are priced from current product data, resolved the same way
  // the order was originally priced (client's price group, then their
  // negotiated remise, if any).
  const client = await findClientByEmail<{ remise: number | null; price_group_id: string | null }>(order.email, 'remise, price_group_id');
  const remisePct = client?.remise ?? null;
  const priceOverrides = await fetchClientPriceOverrides(client?.price_group_id ?? null);

  const added: Array<{ name: string; qty: number }> = [];
  const removed: Array<{ name: string; qty: number }> = [];
  const changed: Array<{ name: string; from: number; to: number }> = [];
  const items: OrderLineInput[] = [];

  for (const [pid, qty] of submitted) {
    const existing = currentByProduct.get(pid);
    if (existing) {
      // Only the quantity changes for an existing line — snapshot fields are
      // left untouched by the RPC's update branch.
      items.push({
        product_id:        pid,
        product_name:      existing.product_name,
        quantity:          qty,
        unit:              null,
        price_ht_snapshot: null,
        tva_rate_snapshot: null,
        pump_snapshot:     null,
      });
      if (existing.quantity !== qty) changed.push({ name: existing.product_name, from: existing.quantity, to: qty });
    } else {
      const prod = productMap.get(pid);
      if (!prod) continue;
      items.push({
        product_id:        pid,
        product_name:      prod.name,
        quantity:          qty,
        unit:              prod.unit,
        price_ht_snapshot: resolveClientPrice(pid, prod.price_ht, priceOverrides, remisePct),
        tva_rate_snapshot: prod.tva_rate,
        pump_snapshot:     prod.prix_achat_moyen_ht,
      });
      added.push({ name: prod.name, qty });
    }
  }

  const toDelete = (currentItems ?? []).filter(it => it.product_id && !submitted.has(it.product_id));
  for (const it of toDelete) removed.push({ name: it.product_name, qty: it.quantity });

  if (items.length === 0) return redirectTo(`/admin/commandes/${id}/edit?error=empty`);

  // Atomic RPC: verrouille les produits concernés, recalcule le disponible en
  // excluant les propres lignes de cette commande, puis n'écrit que si tout
  // passe — jamais de vérification-puis-écriture en étapes séparées (même
  // exigence que la création, voir order_create_checked).
  const result = await updateOrderChecked(id, items);

  if (!result.ok) {
    if ('conflicts' in result) return redirectTo(`/admin/commandes/${id}/edit?error=stock`);
    return redirectTo(`/admin/commandes/${id}/edit?error=erreur`);
  }

  if (added.length || removed.length || changed.length) {
    const summary = [
      added.length   ? `+${added.length} produit(s) ajouté(s)` : null,
      removed.length ? `-${removed.length} produit(s) retiré(s)` : null,
      changed.length ? `${changed.length} quantité(s) modifiée(s)` : null,
    ].filter(Boolean).join(' · ');

    await logAdminAction({
      adminEmail: user.email ?? 'inconnu',
      action: 'commande.modification',
      targetType: 'order',
      targetId: id,
      targetLabel: order.societe ?? order.nom,
      details: { resume: summary, ajoutes: added, retires: removed, modifies: changed },
    });
  }

  return redirectTo('/admin/commandes?updated=1');
};
