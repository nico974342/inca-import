import type { APIRoute } from 'astro';
import { createAuthClient, supabaseAdmin } from '../../../../lib/supabase';
import { isAdmin } from '../../../../lib/roles';

// Brouillon des quantités retenues à la main, lié à l'admin ET au produit —
// voir supabase/migrations/commande_fournisseur_drafts_et_idempotence.sql.
// localStorage (côté page) reste un cache de secours pour l'affichage
// immédiat ; cette table est la sauvegarde qui survit à une reconnexion ou
// à un changement d'ordinateur.

export const GET: APIRoute = async ({ request, cookies }) => {
  const supabase = createAuthClient(request, cookies);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user || !isAdmin(user)) return new Response('Non autorisé', { status: 401 });

  const { data, error } = await supabaseAdmin
    .from('commande_fournisseur_drafts')
    .select('product_id, quantity')
    .eq('admin_email', user.email ?? '');

  if (error) {
    // Table pas encore migrée, ou autre souci de lecture : le brouillon
    // serveur devient simplement indisponible pour cette session, sans
    // bloquer la page — le localStorage prend le relais.
    console.error('[commande-fournisseur/draft] lecture échouée:', error.message);
    return new Response(JSON.stringify({ drafts: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }

  return new Response(JSON.stringify({ drafts: data ?? [] }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
};

export const POST: APIRoute = async ({ request, cookies }) => {
  const supabase = createAuthClient(request, cookies);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user || !isAdmin(user)) return new Response('Non autorisé', { status: 401 });

  let body: { product_id?: string; supplier_name?: string; quantity?: number };
  try {
    body = await request.json();
  } catch {
    return new Response('JSON invalide', { status: 400 });
  }

  const productId = body.product_id;
  const supplierName = (body.supplier_name ?? '').trim();
  const quantity = body.quantity;

  if (!productId || !supplierName || !Number.isFinite(quantity) || (quantity as number) < 0) {
    return new Response('Paramètres invalides', { status: 400 });
  }

  const { error } = await supabaseAdmin
    .from('commande_fournisseur_drafts')
    .upsert(
      { admin_email: user.email ?? '', product_id: productId, supplier_name: supplierName, quantity, updated_at: new Date().toISOString() },
      { onConflict: 'admin_email,product_id' },
    );

  if (error) {
    console.error('[commande-fournisseur/draft] écriture échouée:', error.message);
    return new Response('Échec de l’enregistrement', { status: 500 });
  }

  return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
};

// « Revenir à la proposition » : la ligne n'est plus une retenue manuelle,
// son brouillon serveur ne doit plus la réappliquer au prochain chargement —
// sinon la valeur manuelle reviendrait silencieusement après rechargement
// malgré le clic sur « revenir à la proposition ».
export const DELETE: APIRoute = async ({ request, cookies }) => {
  const supabase = createAuthClient(request, cookies);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user || !isAdmin(user)) return new Response('Non autorisé', { status: 401 });

  let body: { product_id?: string };
  try {
    body = await request.json();
  } catch {
    return new Response('JSON invalide', { status: 400 });
  }
  const productId = body.product_id;
  if (!productId) return new Response('Paramètres invalides', { status: 400 });

  const { error } = await supabaseAdmin
    .from('commande_fournisseur_drafts')
    .delete()
    .eq('admin_email', user.email ?? '')
    .eq('product_id', productId);

  if (error) {
    console.error('[commande-fournisseur/draft] suppression échouée:', error.message);
    return new Response('Échec de la suppression', { status: 500 });
  }

  return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
};
