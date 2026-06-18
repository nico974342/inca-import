import type { APIRoute } from 'astro';
import { createAuthClient, supabaseAdmin } from '../../../../../lib/supabase';

export const POST: APIRoute = async ({ params, request, cookies }) => {
  const supabase = createAuthClient(request, cookies);
  const { data: { user } } = await supabase.auth.getUser();

  if (!user || user.user_metadata?.role === 'client') {
    return new Response('Non autorisé', { status: 401 });
  }

  const { id } = params;
  if (!id) return new Response('Non trouvé', { status: 404 });

  const { data: order } = await supabaseAdmin
    .from('orders')
    .select('id')
    .eq('id', id)
    .single();

  if (!order) return new Response('Non trouvé', { status: 404 });

  const formData = await request.formData();
  const file = formData.get('invoice_pdf') as File | null;

  if (!file || file.size === 0) {
    return new Response('Fichier manquant', { status: 400 });
  }

  const MAX_SIZE = 10 * 1024 * 1024; // 10 MB
  if (file.size > MAX_SIZE) {
    return new Response('Fichier trop volumineux (max 10 Mo)', { status: 413 });
  }

  const arrayBuffer = await file.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);

  // Verify PDF magic bytes (%PDF-) — cannot be spoofed unlike Content-Type
  if (buffer.length < 5 || buffer[0] !== 0x25 || buffer[1] !== 0x50 ||
      buffer[2] !== 0x44 || buffer[3] !== 0x46 || buffer[4] !== 0x2D) {
    return new Response('Le fichier doit être un PDF valide', { status: 400 });
  }
  const storagePath = `${id}/facture.pdf`;

  const { error: uploadError } = await supabaseAdmin.storage
    .from('invoices')
    .upload(storagePath, buffer, {
      contentType: 'application/pdf',
      upsert: true,
    });

  if (uploadError) {
    console.error('[upload-invoice] storage error', uploadError);
    return new Response('Erreur lors du téléversement', { status: 500 });
  }

  const { error: updateError } = await supabaseAdmin
    .from('orders')
    .update({ invoice_path: storagePath })
    .eq('id', id);

  if (updateError) {
    console.error('[upload-invoice] db error', updateError);
    return new Response('Erreur lors de la mise à jour', { status: 500 });
  }

  return Response.redirect(new URL('/admin/commandes', request.url).toString(), 303);
};
