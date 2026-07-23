import type { APIRoute } from 'astro';
import { createAuthClient, supabaseAdmin } from '../../../../../lib/supabase';
import { logAdminAction } from '../../../../../lib/audit';
import { normalizeEmail } from '../../../../../lib/clients';

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

  // Resolve auth user ID: prefer stored user_id, fallback to email search
  // (paginated — Supabase caps each page, so loop until exhausted)
  let authUserId: string | null = (client as any).user_id ?? null;
  if (!authUserId) {
    const wanted = normalizeEmail(client.email);
    let page = 1;
    while (!authUserId) {
      const { data: users } = await supabaseAdmin.auth.admin.listUsers({ page, perPage: 1000 });
      const batch = users?.users ?? [];
      const found = batch.find((u: any) => normalizeEmail(u.email) === wanted);
      authUserId = found?.id ?? null;
      if (batch.length < 1000) break;
      page++;
    }
  }

  const base = new URL(request.url).origin;

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

  // Store user_id for future use; activate account when promoting
  await supabaseAdmin.from('client_accounts').update({
    user_id: authUserId,
    ...(action === 'promote' ? { status: 'actif' } : {}),
  }).eq('id', id);

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
