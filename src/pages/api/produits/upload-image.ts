import type { APIRoute } from 'astro';
import { createAuthClient, supabaseAdmin } from '../../../lib/supabase';

const BUCKET = 'product-images';
const MAX_SIZE = 5 * 1024 * 1024; // 5 MB

const ALLOWED_TYPES: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png':  'png',
  'image/webp': 'webp',
};

function json(body: Record<string, unknown>, status: number) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

// Content-Type is client-supplied and can be spoofed — check the actual
// file signature so a renamed .exe can't slip through as "image/png".
function matchesSignature(ext: string, buf: Buffer): boolean {
  if (buf.length < 12) return false;
  if (ext === 'jpg')  return buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
  if (ext === 'png')  return buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47;
  if (ext === 'webp') return buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP';
  return false;
}

async function ensureBucket() {
  const { data: existing } = await supabaseAdmin.storage.getBucket(BUCKET);
  if (existing) return;
  const { error } = await supabaseAdmin.storage.createBucket(BUCKET, {
    public: true,
    fileSizeLimit: MAX_SIZE,
    allowedMimeTypes: Object.keys(ALLOWED_TYPES),
  });
  // Ignore a race where another request created it in between the check and here.
  if (error && !/already exists/i.test(error.message)) throw error;
}

export const POST: APIRoute = async ({ request, cookies }) => {
  const supabase = createAuthClient(request, cookies);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user || user.user_metadata?.role === 'client') {
    return json({ error: 'Non autorisé' }, 401);
  }

  const formData = await request.formData();
  const file = formData.get('image') as File | null;

  if (!file || file.size === 0) return json({ error: 'Aucun fichier reçu.' }, 400);
  if (file.size > MAX_SIZE) return json({ error: 'Fichier trop volumineux (max 5 Mo).' }, 413);

  const ext = ALLOWED_TYPES[file.type];
  if (!ext) return json({ error: 'Format non supporté (JPEG, PNG ou WEBP uniquement).' }, 400);

  const buffer = Buffer.from(await file.arrayBuffer());
  if (!matchesSignature(ext, buffer)) {
    return json({ error: "Le contenu du fichier ne correspond pas à une image valide." }, 400);
  }

  try {
    await ensureBucket();
  } catch (err) {
    console.error('[produits/upload-image] bucket error:', err);
    return json({ error: 'Erreur de configuration du stockage.' }, 500);
  }

  const path = `${crypto.randomUUID()}.${ext}`;
  const { error: uploadError } = await supabaseAdmin.storage
    .from(BUCKET)
    .upload(path, buffer, { contentType: file.type, upsert: false });

  if (uploadError) {
    console.error('[produits/upload-image] storage error:', uploadError.message);
    return json({ error: 'Erreur lors du téléversement.' }, 500);
  }

  const { data: pub } = supabaseAdmin.storage.from(BUCKET).getPublicUrl(path);
  return json({ url: pub.publicUrl }, 200);
};
