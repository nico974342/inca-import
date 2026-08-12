import type { APIRoute } from 'astro';
import { createAuthClient, supabaseAdmin } from '../../../../../lib/supabase';
import { logAdminAction } from '../../../../../lib/audit';
import { findAuthUserIdByEmail } from '../../../../../lib/clients';

export const POST: APIRoute = async ({ params, request, cookies }) => {
  const supabase = createAuthClient(request, cookies);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user || user.user_metadata?.role === 'client') {
    return new Response('Non autorisé', { status: 401 });
  }

  const { id } = params;
  if (!id) return new Response('ID manquant', { status: 404 });

  const form = await request.formData();
  const action = form.get('action') as string; // 'promote' | 'demote'

  const { data: client, error: clientErr } = await supabaseAdmin
    .from('client_accounts')
    .select('*')
    .eq('id', id)
    .single();

  if (clientErr || !client) {
    return new Response(`Client introuvable (${clientErr?.message ?? 'no data'})`, { status: 404 });
  }

  if (!client.email) {
    return new Response('Ce client n\'a pas d\'email enregistré.', { status: 400 });
  }

  const base = new URL(request.url).origin;

  // client_accounts has no user_id column — email is the only link to auth.users.
  let authUserId: string | null;
  try {
    authUserId = await findAuthUserIdByEmail(client.email);
  } catch {
    return Response.redirect(`${base}/admin/clients/${id}?role_error=update_failed`, 303);
  }

  if (!authUserId) {
    return Response.redirect(`${base}/admin/clients/${id}?role_error=no_auth_user`, 303);
  }

  const newRole = action === 'promote' ? 'admin' : 'client';
  const { error: updateErr } = await supabaseAdmin.auth.admin.updateUserById(authUserId, {
    user_metadata: { role: newRole },
  });

  if (updateErr) {
    return Response.redirect(`${base}/admin/clients/${id}?role_error=update_failed`, 303);
  }

  // Activate account when promoting. client_accounts has no user_id column —
  // writing one here made PostgREST reject the whole update, so the status
  // change silently never applied.
  if (action === 'promote') {
    const { error: statusErr } = await supabaseAdmin
      .from('client_accounts')
      .update({ status: 'actif' })
      .eq('id', id);
    if (statusErr) {
      return Response.redirect(`${base}/admin/clients/${id}?role_error=update_failed`, 303);
    }
  }

  await logAdminAction({
    adminEmail: user.email ?? 'inconnu',
    action: action === 'promote' ? 'client.promotion_admin' : 'client.retrogradation',
    targetType: 'client',
    targetId: id,
    targetLabel: client.email,
    details: { nouveau_role: newRole },
  });

  return Response.redirect(`${base}/admin/clients/${id}`, 303);
};
