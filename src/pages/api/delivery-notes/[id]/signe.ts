import type { APIRoute } from 'astro';
import { createAuthClient, supabaseAdmin } from '../../../../lib/supabase';
import { findClientByEmail } from '../../../../lib/clients';
import { isClientRole } from '../../../../lib/roles';
import { construireBlSigne } from '../../../../lib/blSignatures';

// BL signé (PDF avec les deux signatures). Le BL non signé reste servi par /download, inchangé.
// Staff : tout BL. Client : uniquement les siens, en lecture — il ne peut pas signer.
export const GET: APIRoute = async ({ params, request, cookies }) => {
  const supabase = createAuthClient(request, cookies);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return new Response('Non autorisé', { status: 401 });

  const id = params.id;
  if (!id || !/^[0-9a-f-]{36}$/i.test(id)) return new Response('Non trouvé', { status: 404 });

  if (isClientRole(user)) {
    const { data: note } = await supabaseAdmin.from('delivery_notes').select('client_id').eq('id', id).maybeSingle();
    const account = await findClientByEmail<{ id: string }>(user.email, 'id');
    if (!note || !account || (note as any).client_id !== account.id) return new Response('Interdit', { status: 403 });
  }

  const signe = await construireBlSigne(id);
  if (!signe) return new Response("Ce bon de livraison n'est pas (encore) entièrement signé.", { status: 404 });

  return new Response(signe.buffer, {
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `inline; filename="${signe.blNumber}-signe.pdf"`,
      'Content-Length': String(signe.buffer.length),
      'Cache-Control': 'private, no-store',
    },
  });
};
