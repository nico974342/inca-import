import type { APIRoute } from 'astro';
import { createAuthClient, supabaseAdmin } from '../../../../lib/supabase';
import { findClientByEmail } from '../../../../lib/clients';
import { isClientRole } from '../../../../lib/roles';
import { fetchLiensBl, lireBlOriginal } from '../../../../lib/blSignatures';
import { clientPeutConsulterBl } from '../../../../lib/blAcces';

export const GET: APIRoute = async ({ params, request, cookies }) => {
  const supabase = createAuthClient(request, cookies);
  const { data: { user } } = await supabase.auth.getUser();

  if (!user) return new Response('Non autorisé', { status: 401 });

  // Staff (admin or commercial) can download any delivery note — only a
  // client account is restricted to its own.
  const isClient = isClientRole(user);

  const { id } = params;
  if (!id) return new Response('Non trouvé', { status: 404 });

  const { data: note } = await supabaseAdmin
    .from('delivery_notes')
    .select('id, client_id, storage_path, pdv_name, delivery_id, contenu')
    .eq('id', id)
    .single();

  if (!note) return new Response('Non trouvé', { status: 404 });

  if (isClient) {
    // Un client ne voit que SES bons : toutes les commandes du BL doivent être les siennes (identifiant du compte) ;
    // repli sur le rattachement historique à la fiche client pour les commandes sans compte (voir lib/blAcces.ts).
    const account = await findClientByEmail<{ id: string }>(user.email, 'id');
    const liens = (await fetchLiensBl([id])).get(id) ?? [];
    if (!clientPeutConsulterBl({ userId: user.id, accountId: account?.id ?? null, noteClientId: (note as any).client_id ?? null, liens })) {
      return new Response('Interdit', { status: 403 });
    }
  }

  // BL au contenu figé : archive du stockage, sinon reconstruction à l'identique (le BL ne dépend jamais de la commande).
  if ((note as any).contenu) {
    const bl = await lireBlOriginal(id);
    if (bl) {
      return new Response(bl.buffer, {
        headers: {
          'Content-Type': 'application/pdf',
          'Content-Disposition': `inline; filename="${bl.blNumber}.pdf"`,
          'Content-Length': String(bl.buffer.length),
          'Cache-Control': 'private, no-store',
        },
      });
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
