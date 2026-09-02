import type { APIRoute } from 'astro';
import { createAuthClient, supabaseAdmin } from '../../../../../lib/supabase';
import { logAdminAction } from '../../../../../lib/audit';
import { findAuthUserIdByEmail } from '../../../../../lib/clients';
import { isAdmin, ROLE_LABEL, type UserRole } from '../../../../../lib/roles';

const ASSIGNABLE_ROLES: readonly UserRole[] = ['admin', 'commercial', 'client'];

export const POST: APIRoute = async ({ params, request, cookies }) => {
  const supabase = createAuthClient(request, cookies);
  const { data: { user } } = await supabase.auth.getUser();
  // Changer le rôle d'un compte est réservé aux admins — un commercial ne
  // doit jamais pouvoir se (ou faire) promouvoir.
  if (!user || !isAdmin(user)) {
    return new Response('Non autorisé', { status: 401 });
  }

  const { id } = params;
  if (!id) return new Response('ID manquant', { status: 404 });

  const form = await request.formData();
  const newRole = form.get('role') as string;
  if (!ASSIGNABLE_ROLES.includes(newRole as UserRole)) {
    return new Response('Rôle invalide', { status: 400 });
  }

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

  const { data: found } = await supabaseAdmin.auth.admin.getUserById(authUserId);
  const previousRole = (found?.user?.user_metadata as any)?.role ?? 'client';

  const { error: updateErr } = await supabaseAdmin.auth.admin.updateUserById(authUserId, {
    user_metadata: { role: newRole },
  });

  if (updateErr) {
    return Response.redirect(`${base}/admin/clients/${id}?role_error=update_failed`, 303);
  }

  // Activate account when granting a staff seat — client_accounts has no
  // user_id column, so writing one here made PostgREST reject the whole
  // update and the status change silently never applied.
  if (newRole !== 'client') {
    const { error: statusErr } = await supabaseAdmin
      .from('client_accounts')
      .update({ status: 'actif' })
      .eq('id', id);
    if (statusErr) {
      return Response.redirect(`${base}/admin/clients/${id}?role_error=update_failed`, 303);
    }
  }

  if (previousRole !== newRole) {
    await logAdminAction({
      adminEmail: user.email ?? 'inconnu',
      action: 'client.changement_role',
      targetType: 'client',
      targetId: id,
      targetLabel: client.email,
      details: { ancien: ROLE_LABEL[(previousRole as UserRole) ?? 'client'] ?? previousRole, nouveau: ROLE_LABEL[newRole as UserRole] },
    });
  }

  return Response.redirect(`${base}/admin/clients/${id}`, 303);
};
