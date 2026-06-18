import type { APIRoute } from 'astro';
import { createAuthClient, supabaseAdmin } from '../../../../lib/supabase';

export const GET: APIRoute = async ({ params, request, cookies }) => {
  const supabase = createAuthClient(request, cookies);
  const { data: { user } } = await supabase.auth.getUser();

  if (!user) return new Response('Non autorisé', { status: 401 });

  const role = user.user_metadata?.role as string | undefined;
  const isAdmin = role === 'admin';
  const isClient = role === 'client';

  if (!isAdmin && !isClient) return new Response('Non autorisé', { status: 401 });

  const { id } = params;
  if (!id) return new Response('Non trouvé', { status: 404 });

  const { data: note } = await supabaseAdmin
    .from('delivery_notes')
    .select('id, client_id, storage_path, pdv_name, delivery_id')
    .eq('id', id)
    .single();

  if (!note) return new Response('Non trouvé', { status: 404 });

  if (isClient) {
    // Verify ownership: match logged-in user's email → client_accounts.id
    const { data: account } = await supabaseAdmin
      .from('client_accounts')
      .select('id')
      .eq('email', (user.email ?? '').toLowerCase())
      .maybeSingle();

    if (!account || note.client_id !== account.id) {
      return new Response('Interdit', { status: 403 });
    }
  }

  const { data: signed } = await supabaseAdmin.storage
    .from('delivery-notes')
    .createSignedUrl(note.storage_path, 3600);

  if (!signed?.signedUrl) {
    return new Response('Lien de téléchargement indisponible', { status: 500 });
  }

  return Response.redirect(signed.signedUrl, 302);
};
