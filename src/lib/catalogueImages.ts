import sharp from 'sharp';

// Images embarquées dans le catalogue PDF — jamais de blocage complet de la
// génération pour une seule image lente ou cassée : chaque téléchargement a
// un délai maximum et un échec individuel ne fait qu'omettre CETTE image
// (le PDF retombe sur le placeholder pour ce produit), voir generateCataloguePDF.

// Délai généreux : chaque image est aussi redimensionnée/recompressée par
// sharp (CPU), pas seulement téléchargée — sous 8 requêtes concurrentes, le
// temps de traitement s'additionne au temps réseau. Un timeout trop serré ici
// bascule des produits ayant une vraie photo dans le bloc "sans photo" pour
// une simple lenteur passagère, pas une image réellement indisponible.
const FETCH_TIMEOUT_MS = 8000;
const MAX_CONCURRENT = 6;

// Les photos produit sources (WebP compris — PDFKit ne lit que JPEG/PNG) font
// souvent plusieurs centaines de Ko à quelques Mo pièce. Embarquées telles
// quelles dans ~70-80 vignettes, le PDF dépassait 14 Mo pour un catalogue
// complet. Chaque image est donc systématiquement redimensionnée à sa taille
// d'affichage réelle (vignette catalogue, jamais agrandie) et recompressée en
// JPEG — largement suffisant à l'écran comme à l'impression, et le format qui
// compresse le mieux une photo (contrairement au PNG utilisé avant pour le
// seul cas WebP).
const MAX_IMG_PX = 360;
const JPEG_QUALITY = 78;

async function normalizeForPdf(buffer: Buffer): Promise<Buffer | null> {
  try {
    return await sharp(buffer)
      .rotate() // respecte l'orientation EXIF avant le redimensionnement
      .resize({ width: MAX_IMG_PX, height: MAX_IMG_PX, fit: 'inside', withoutEnlargement: true })
      // Un PNG à fond transparent recompressé tel quel en JPEG deviendrait noir
      // (fond par défaut de sharp) — aplati sur blanc, comme le reste de la page.
      .flatten({ background: '#ffffff' })
      .jpeg({ quality: JPEG_QUALITY })
      .toBuffer();
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
