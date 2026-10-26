import type { APIRoute } from 'astro';
import { createAuthClient, supabaseAdmin } from '../../../../../lib/supabase';
import { logAdminAction } from '../../../../../lib/audit';
import { isAdmin } from '../../../../../lib/roles';

// Accorde ou retire à UN client l'accès à un produit masqué du catalogue
// (table client_product_access). Corps JSON : { product_id: string, allowed: boolean }.
//
// Réservé aux admins, contrôlé ici côté serveur : le commercial voit les
// accès sur la fiche client mais ne peut pas les modifier.

function json(status: number, body: Record<string, unknown>) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

export const POST: APIRoute = async ({ params, request, cookies }) => {
  const supabase = createAuthClient(request, cookies);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return json(401, { error: 'Non autorisé' });
  if (!isAdmin(user)) return json(403, { error: 'Réservé aux administrateurs' });

  const clientId = params.id;
  const body = (await request.json().catch(() => null)) as { product_id?: unknown; allowed?: unknown } | null;
  if (!clientId || typeof body?.product_id !== 'string' || !body.product_id || typeof body.allowed !== 'boolean') {
    return json(400, { error: 'Paramètres invalides' });
  }
  const productId = body.product_id;
  const allowed = body.allowed;

  const [{ data: client }, { data: product }] = await Promise.all([
    supabaseAdmin.from('client_accounts').select('nom, societe').eq('id', clientId).maybeSingle(),
    supabaseAdmin.from('products').select('name').eq('id', productId).maybeSingle(),
  ]);
  if (!client) return json(404, { error: 'Client introuvable' });
  if (!product) return json(404, { error: 'Produit introuvable' });

  const { data: existing, error: readErr } = await supabaseAdmin
    .from('client_product_access')
    .select('id')
    .eq('client_id', clientId)
    .eq('product_id', productId)
    .maybeSingle();
  if (readErr) {
    console.error('[client product-access] lecture:', readErr.message);
    return json(500, { error: 'Erreur serveur' });
  }

  // Déjà dans l'état demandé (double clic, deux onglets) : rien à écrire ni à journaliser.
  if (!!existing === allowed) return json(200, { ok: true, allowed, unchanged: true });

  const { error } = allowed
    ? await supabaseAdmin.from('client_product_access').insert({ client_id: clientId, product_id: productId })
    : await supabaseAdmin.from('client_product_access').delete().eq('client_id', clientId).eq('product_id', productId);

  // 23505 : une requête concurrente a déjà posé l'accès — même résultat voulu.
  if (error && error.code !== '23505') {
    console.error('[client product-access] écriture:', error.message);
    return json(500, { error: 'Enregistrement impossible' });
  }

  await logAdminAction({
    adminEmail: user.email ?? 'inconnu',
    action: 'client.acces_produit',
    targetType: 'client',
    targetId: clientId,
    targetLabel: client.societe ?? client.nom,
    details: { produit: product.name, acces: allowed ? 'accordé' : 'retiré' },
  });

  return json(200, { ok: true, allowed });
};
