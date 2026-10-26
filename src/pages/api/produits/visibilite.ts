import type { APIRoute } from 'astro';
import { createAuthClient, supabaseAdmin } from '../../../lib/supabase';
import { logAdminAction } from '../../../lib/audit';
import { isAdmin } from '../../../lib/roles';

// Bascule la visibilité catalogue d'un produit depuis la liste /admin/produits.
// Corps JSON : { id: string, visible: boolean }.
//
// Réservé aux admins : le commercial voit l'état dans la liste mais ne peut pas
// le modifier — le rejet est ici, côté serveur, pas seulement dans l'interface.
// (Le middleware laisse passer tout le staff sur /api/produits, d'où le
// contrôle de rôle explicite.)

function json(status: number, body: Record<string, unknown>) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

export const POST: APIRoute = async ({ request, cookies }) => {
  const supabase = createAuthClient(request, cookies);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return json(401, { error: 'Non autorisé' });
  if (!isAdmin(user)) return json(403, { error: 'Réservé aux administrateurs' });

  const body = (await request.json().catch(() => null)) as { id?: unknown; visible?: unknown } | null;
  if (typeof body?.id !== 'string' || !body.id || typeof body.visible !== 'boolean') {
    return json(400, { error: 'Paramètres invalides' });
  }
  const { id, visible } = body;

  const { data: before, error: readErr } = await supabaseAdmin
    .from('products')
    .select('name, visible_catalogue')
    .eq('id', id)
    .maybeSingle();

  if (readErr) {
    console.error('[produits/visibilite] lecture:', readErr.message);
    return json(500, { error: 'Erreur serveur' });
  }
  if (!before) return json(404, { error: 'Produit introuvable' });

  // Déjà dans l'état demandé (double clic, deux onglets) : rien à écrire ni à journaliser.
  if (before.visible_catalogue === visible) return json(200, { ok: true, visible, unchanged: true });

  const { error: updErr } = await supabaseAdmin
    .from('products')
    .update({ visible_catalogue: visible })
    .eq('id', id);

  if (updErr) {
    console.error('[produits/visibilite] écriture:', updErr.message);
    return json(500, { error: 'Enregistrement impossible' });
  }

  await logAdminAction({
    adminEmail: user.email ?? 'inconnu',
    action: 'produit.visibilite_catalogue',
    targetType: 'produit',
    targetId: id,
    targetLabel: before.name,
    details: {
      ancien: before.visible_catalogue ? 'visible' : 'masqué',
      nouveau: visible ? 'visible' : 'masqué',
    },
  });

  return json(200, { ok: true, visible });
};
