import sharp from 'sharp';

// Images embarquées dans le catalogue PDF — jamais de blocage complet de la
// génération pour une seule image lente ou cassée : chaque téléchargement a
// un délai maximum et un échec individuel ne fait qu'omettre CETTE image
// (le PDF retombe sur le placeholder pour ce produit), voir generateCataloguePDF.

const FETCH_TIMEOUT_MS = 4000;
const MAX_CONCURRENT = 8;

/** PDFKit n'accepte que JPEG et PNG — un WebP (format autorisé à l'upload,
 *  voir /api/produits/upload-image.ts) doit être reconverti avant d'être
 *  embarqué, sinon PDFKit lève une erreur qui casserait tout le document. */
async function normalizeForPdf(buffer: Buffer): Promise<Buffer | null> {
  const isJpeg = buffer.length > 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
  const isPng  = buffer.length > 4 && buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47;
  if (isJpeg || isPng) return buffer;
  try {
    // Tout le reste (WebP, ou un format imprévu) passe par sharp — reconverti
    // en PNG, jamais réinjecté tel quel dans PDFKit.
    return await sharp(buffer).png().toBuffer();
  } catch {
    return null;
  }
}

async function fetchOne(url: string): Promise<Buffer | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) return null;
    const buffer = Buffer.from(await res.arrayBuffer());
    if (buffer.length === 0) return null;
    return await normalizeForPdf(buffer);
  } catch {
    // Timeout, réseau, image illisible — jamais remonté à l'appelant comme
    // une erreur bloquante, voir le commentaire en tête de fichier.
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Télécharge et normalise (JPEG/PNG uniquement) les images des produits
 *  donnés, avec un délai maximum par image et un plafond de requêtes
 *  simultanées — jamais toutes les images en même temps sur un catalogue de
 *  80+ produits. Un produit sans image, ou dont l'image échoue/expire,
 *  n'apparaît simplement pas dans la Map retournée : à l'appelant d'utiliser
 *  le placeholder pour ces id-là. */
export async function fetchProductImages(
  products: { id: string; imageUrl: string | null }[],
): Promise<Map<string, Buffer>> {
  const result = new Map<string, Buffer>();
  const queue = products.filter((p): p is { id: string; imageUrl: string } => !!p.imageUrl);
  let idx = 0;

  async function worker() {
    for (;;) {
      const i = idx++;
      if (i >= queue.length) return;
      const { id, imageUrl } = queue[i];
      const buf = await fetchOne(imageUrl);
      if (buf) result.set(id, buf);
    }
  }

  await Promise.all(Array.from({ length: Math.min(MAX_CONCURRENT, queue.length) }, worker));
  return result;
}
