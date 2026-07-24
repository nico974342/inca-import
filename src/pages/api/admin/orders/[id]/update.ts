import type { APIRoute } from 'astro';
import { createAuthClient, supabaseAdmin } from '../../../../../lib/supabase';
import { logAdminAction } from '../../../../../lib/audit';
import { findClientByEmail, applyRemise } from '../../../../../lib/clients';
import { isOrderEditable } from '../../../../../lib/constants';

export const POST: APIRoute = async ({ params, request, cookies }) => {
  const supabase = createAuthClient(request, cookies);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user || user.user_metadata?.role === 'client') {
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
    .select('id, name, unit, price_ht, tva_rate, prix_achat_moyen_ht, stock_quantity')
    .in('id', [...submitted.keys()]);
  const productMap = new Map((productsData ?? []).map(p => [p.id, p]));

  // Stock only needs checking when a line is new or its quantity is going UP —
  // nothing was ever decremented for this order pre-livraison, so an unchanged
  // or reduced line can never violate availability.
  const violations: string[] = [];
  for (const [pid, qty] of submitted) {
    const existing = currentByProduct.get(pid);
    const baseline = existing?.quantity ?? 0;
    if (qty > baseline) {
      const prod = productMap.get(pid);
      const stock = prod?.stock_quantity ?? 0;
      if (qty > stock) violations.push(prod?.name ?? existing?.product_name ?? pid);
    }
  }
  if (violations.length > 0) return redirectTo(`/admin/commandes/${id}/edit?error=stock`);

  // New lines are priced from current product data, discounted the same way
  // the order was originally priced (client's negotiated remise, if any).
  const client = await findClientByEmail(order.email, 'remise');
  const remisePct = (client as { remise: number | null } | null)?.remise ?? null;

  const added: Array<{ name: string; qty: number }> = [];
  const removed: Array<{ name: string; qty: number }> = [];
  const changed: Array<{ name: string; from: number; to: number }> = [];
  const toInsert: Array<Record<string, unknown>> = [];

  for (const [pid, qty] of submitted) {
    const existing = currentByProduct.get(pid);
    if (existing) {
      if (existing.quantity !== qty) {
        await supabaseAdmin.from('order_items').update({ quantity: qty }).eq('id', existing.id);
        changed.push({ name: existing.product_name, from: existing.quantity, to: qty });
      }
    } else {
      const prod = productMap.get(pid);
      if (!prod) continue;
      toInsert.push({
        order_id:          id,
        product_id:        pid,
        product_name:      prod.name,
        quantity:          qty,
        unit:              prod.unit,
        price_ht_snapshot: applyRemise(prod.price_ht, remisePct),
        tva_rate_snapshot: prod.tva_rate,
        pump_snapshot:     prod.prix_achat_moyen_ht,
      });
      added.push({ name: prod.name, qty });
    }
  }

  if (toInsert.length > 0) {
    const { error: insertErr } = await supabaseAdmin.from('order_items').insert(toInsert);
    if (insertErr) {
      console.error('[orders/update] insert error:', insertErr.message);
      return redirectTo(`/admin/commandes/${id}/edit?error=erreur`);
    }
  }

  const toDelete = (currentItems ?? []).filter(it => it.product_id && !submitted.has(it.product_id));
  for (const it of toDelete) {
    await supabaseAdmin.from('order_items').delete().eq('id', it.id);
    removed.push({ name: it.product_name, qty: it.quantity });
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
