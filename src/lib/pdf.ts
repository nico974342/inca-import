import PDFDocument from 'pdfkit';
import { COMPANY, COMPANY_ADDRESS_LINE, DEFAULT_TVA_RATE } from './constants';

// ── Catalogue produits (PDF imprimable) ─────────────────────────────────────
// Document commercial séparé des bons de commande/livraison ci-dessus, mais
// même bibliothèque (PDFKit) et mêmes couleurs de marque, pour rester
// cohérent. AUCUNE donnée de coût ou de marge n'y transite jamais — ce module
// ne reçoit que des prix de vente déjà résolus par l'appelant (voir
// lib/clients.ts, resolveGroupPrice) et des images déjà téléchargées et
// redimensionnées (lib/catalogueImages.ts) ; il ne lit ni ne calcule rien
// d'autre.
//
// Gabarit fixe : la mise en page ci-dessous reproduit une maquette de
// référence (catalogue "Boissons" fourni) par du code déterministe — aucun
// appel IA à la génération, chaque exécution produit la même direction
// graphique avec les données du moment.

export interface CatalogueProductInput {
  id: string;
  name: string;
  category: string;
  categoryLabel: string;
  unit: string | null;
  unitsPerCarton: number | null;
  /** Prix carton déjà résolu (groupe tarifaire, sinon prix de base) — jamais
   *  recalculé ici. Null seulement si le catalogue produit n'a aucun prix HT
   *  enregistré du tout (cas résiduel, affiché "—"). */
  cartonPriceHt: number | null;
  /** Image déjà téléchargée, redimensionnée et normalisée en JPEG (PDFKit ne
   *  lit pas le WebP) — null = pas d'image ou téléchargement/format en échec,
   *  jamais bloquant : le produit bascule dans le bloc "Également au
   *  catalogue" plutôt que d'afficher un cadre vide dans la grille photo. */
  imageBuffer: Buffer | null;
}

export interface CataloguePdfData {
  /** "Stations INCANA" / "Autres clients" / "Prix de base" */
  groupLabel: string;
  /** "10 septembre 2026" — même chaîne réutilisée dans le pied de page légal. */
  editionDateLabel: string;
  /** "septembre 2026" — utilisé en majuscules dans l'en-tête courant. */
  editionMonthYearLabel: string;
  /** Déjà filtrés (catégories, disponibilité) et triés (catégorie puis nom)
   *  par l'appelant — ce module se contente de les disposer. */
  products: CatalogueProductInput[];
}

const CAT_PRIMARY = '#C96334';
const CAT_INK     = '#1E1A16';
const CAT_MUTED   = '#706B65';
const CAT_SURFACE = '#F6F3EF';
const CAT_BORDER  = '#E7E2DC';

const CAT_PAGE_W  = 595;
const CAT_LEFT    = 40;
const CAT_RIGHT   = 555;
const CAT_WIDTH   = CAT_RIGHT - CAT_LEFT; // 515
const CAT_BOTTOM  = 785; // au-delà, la bande de pied de page (tracée à 800+)

const CATEGORY_TAGLINE: Record<string, string> = {
  Boissons:    'Du choix pour vos rayons.',
  Snacks:      'De quoi tenir toute la journée.',
  Chips:       'Le classique qui ne déçoit jamais.',
  Confiseries: 'Le rayon plaisir, toujours demandé.',
  Divers:      "L'essentiel pour la station.",
};

function euro(n: number): string {
  return `${n.toFixed(2).replace('.', ',')} €`;
}

function chunk3<T>(arr: T[]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += 3) out.push(arr.slice(i, i + 3));
  return out;
}

/** Bande couleur pleine largeur en tête de chaque page — signature visuelle
 *  de la maquette de référence, absente du reste des documents PDFKit du
 *  site (bons de commande/livraison), propre à ce document commercial. */
function drawCatalogueTopBar(doc: PDFKit.PDFDocument): void {
  doc.rect(0, 0, CAT_PAGE_W, 5).fillColor(CAT_PRIMARY).fill();
}

function drawCatalogueCover(doc: PDFKit.PDFDocument, groupLabel: string, editionDateLabel: string): void {
  const centerOpts = { width: 495, align: 'center' as const };

  doc.fontSize(36).font('Helvetica-Bold').fillColor(CAT_PRIMARY).text('Inca Import', 50, 176, centerOpts);
  const ruleW = 70;
  doc.moveTo(297.5 - ruleW / 2, 224).lineTo(297.5 + ruleW / 2, 224).lineWidth(2.5).strokeColor(CAT_PRIMARY).stroke();
  doc.fontSize(10).font('Helvetica').fillColor(CAT_MUTED).text('Grossiste B2B · La Réunion', 50, 238, centerOpts);

  doc.fontSize(24).font('Helvetica-Bold').fillColor(CAT_INK)
    .text('CATALOGUE PRODUITS', 50, 330, { ...centerOpts, characterSpacing: 0.6 });

  const badgeText = `Grille tarifaire — ${groupLabel}`;
  doc.fontSize(11).font('Helvetica-Bold');
  const badgeW = doc.widthOfString(badgeText) + 36;
  const badgeX = 297.5 - badgeW / 2;
  doc.roundedRect(badgeX, 372, badgeW, 28, 14).lineWidth(1).strokeColor(CAT_PRIMARY).fillAndStroke('#FFF6F0', CAT_PRIMARY);
  doc.fillColor(CAT_PRIMARY).text(badgeText, badgeX, 380, { width: badgeW, align: 'center', lineBreak: false });

  doc.fontSize(9.5).font('Helvetica').fillColor(CAT_MUTED)
    .text(`Édition du ${editionDateLabel}`, 50, 418, centerOpts);

  // ── Coordonnées complètes, bas de page de garde ──
  const coordY = 680;
  doc.moveTo(297.5 - 30, coordY - 24).lineTo(297.5 + 30, coordY - 24).lineWidth(0.5).strokeColor(CAT_BORDER).stroke();
  doc.fontSize(11).font('Helvetica-Bold').fillColor(CAT_INK).text(COMPANY.name, 50, coordY, centerOpts);
  doc.fontSize(9).font('Helvetica').fillColor(CAT_MUTED)
    .text(COMPANY_ADDRESS_LINE, 50, coordY + 16, centerOpts)
    .text(`SIRET ${COMPANY.siret}`, 50, coordY + 30, centerOpts)
    .text(`${COMPANY.phoneDisplay}  ·  ${COMPANY.contactEmail}`, 50, coordY + 44, centerOpts)
    .text(COMPANY.siteUrl.replace(/^https?:\/\//, ''), 50, coordY + 58, centerOpts);
}

/** En-tête répété sur chaque page produit — wordmark, "CATALOGUE
 *  PROFESSIONNEL" et grille/édition, repris de la maquette de référence.
 *  Renvoie le Y de départ du contenu. */
function drawCatalogueRunningHeader(doc: PDFKit.PDFDocument, groupLabel: string, monthYearLabel: string): number {
  doc.fontSize(15).font('Helvetica-Bold').fillColor(CAT_PRIMARY)
    .text('Inca', CAT_LEFT, 20, { continued: true, lineBreak: false });
  doc.fillColor(CAT_INK).text(' Import', { lineBreak: false });

  doc.fontSize(9).font('Helvetica-Bold').fillColor(CAT_INK)
    .text('CATALOGUE PROFESSIONNEL', 300, 20, { width: 255, align: 'right', characterSpacing: 0.4, lineBreak: false });
  doc.fontSize(8.5).font('Helvetica').fillColor(CAT_MUTED)
    .text(`${groupLabel} · ${monthYearLabel.toUpperCase()}`, 300, 33, { width: 255, align: 'right', lineBreak: false });

  doc.moveTo(CAT_LEFT, 50).lineTo(CAT_RIGHT, 50).lineWidth(0.5).strokeColor(CAT_BORDER).stroke();
  return 66;
}

/** Titre de catégorie "hero" (nom en grand, nombre de références, accroche)
 *  — reprend directement la composition de la maquette. */
function drawCatalogueCategoryHeader(doc: PDFKit.PDFDocument, label: string, count: number, y: number): number {
  doc.fontSize(20).font('Helvetica-Bold').fillColor(CAT_INK).text(label, CAT_LEFT, y, { lineBreak: false });

  const countText = `${count} RÉFÉRENCE${count > 1 ? 'S' : ''}`;
  doc.fontSize(9.5).font('Helvetica-Bold');
  const countW = doc.widthOfString(countText);
  doc.fillColor(CAT_PRIMARY).text(countText, CAT_RIGHT - countW, y + 2, { lineBreak: false });
  doc.fontSize(8).font('Helvetica').fillColor(CAT_MUTED)
    .text('Vente au carton · tarifs HT', 400, y + 16, { width: 155, align: 'right', lineBreak: false });

  const tagline = CATEGORY_TAGLINE[label] ?? '';
  if (tagline) {
    doc.fontSize(9).font('Helvetica-Oblique').fillColor(CAT_MUTED).text(tagline, CAT_LEFT, y + 27, { lineBreak: false });
  }
  return y + 46;
}

/** En-tête allégé quand une catégorie se poursuit sur une nouvelle page. */
function drawCatalogueContinuationHeader(doc: PDFKit.PDFDocument, label: string, y: number): number {
  doc.fontSize(11).font('Helvetica-Bold').fillColor(CAT_PRIMARY)
    .text(`${label.toUpperCase()} (SUITE)`, CAT_LEFT, y, { characterSpacing: 0.4, lineBreak: false });
  return y + 22;
}

/** Hauteur réelle d'une rangée de 3 cartes photo, dérivée des polices posées
 *  sur `doc` — jamais devinée, sinon deux rangées finiraient par se chevaucher
 *  sans qu'aucun test ne le révèle avant l'impression. Les noms ne sont
 *  JAMAIS tronqués : la rangée s'étend le temps qu'il faut. */
function measureCataloguePhotoRowHeight(doc: PDFKit.PDFDocument, row: CatalogueProductInput[], colW: number, photoH: number): number {
  doc.fontSize(10.5).font('Helvetica-Bold');
  let maxNameH = 0;
  for (const p of row) maxNameH = Math.max(maxNameH, doc.heightOfString(p.name, { width: colW }));
  doc.fontSize(15).font('Helvetica-Bold');
  const priceLH = doc.currentLineHeight();
  doc.fontSize(8.5).font('Helvetica');
  const detailLH = doc.currentLineHeight();
  return photoH + 6 + maxNameH + 4 + priceLH + 2 + detailLH + 14;
}

function drawCataloguePhotoRow(
  doc: PDFKit.PDFDocument, row: CatalogueProductInput[],
  x0: number, y: number, colW: number, gutter: number, photoH: number,
): void {
  row.forEach((p, i) => {
    const x = x0 + i * (colW + gutter);

    // Photo posée directement sur la page, sans cadre — comme la maquette :
    // ce sont des produits photographiés sur fond neutre, pas des vignettes
    // encadrées. Calée en bas (valign bottom) pour un effet "étagère" cohérent
    // entre bouteilles hautes et paquets plus courts.
    if (p.imageBuffer) {
      try {
        doc.image(p.imageBuffer, x, y, { fit: [colW, photoH], align: 'center', valign: 'bottom' });
      } catch { /* image corrompue malgré la normalisation — carte sans photo, jamais bloquant */ }
    }

    let ty = y + photoH + 6;
    doc.fontSize(10.5).font('Helvetica-Bold').fillColor(CAT_INK).text(p.name, x, ty, { width: colW, lineGap: 0 });
    ty += doc.heightOfString(p.name, { width: colW }) + 4;

    doc.fontSize(15).font('Helvetica-Bold');
    const priceLH = doc.currentLineHeight();
    const unitLabel = p.unit ?? 'carton';
    doc.fillColor(CAT_PRIMARY)
      .text(p.cartonPriceHt != null ? euro(p.cartonPriceHt) : '—', x, ty, { continued: true, lineBreak: false });
    doc.fontSize(8.5).font('Helvetica').fillColor(CAT_MUTED).text(`  HT / ${unitLabel}`, { lineBreak: false });
    ty += priceLH + 2;

    if (p.unitsPerCarton != null) {
      const unitPrice = p.cartonPriceHt != null ? p.cartonPriceHt / p.unitsPerCarton : null;
      const detail = unitPrice != null
        ? `${p.unitsPerCarton} unités · env. ${euro(unitPrice)} HT / unité`
        : `${p.unitsPerCarton} unités / carton`;
      doc.fontSize(8.5).font('Helvetica').fillColor(CAT_MUTED).text(detail, x, ty, { width: colW, lineBreak: false });
    }
  });
}

/** Hauteur des rangées du bloc "Également au catalogue" (texte seul, sans
 *  photo) — même principe de mesure préalable que la grille photo. */
function measureNoPhotoRowHeights(doc: PDFKit.PDFDocument, rows: CatalogueProductInput[][], colW: number): number[] {
  return rows.map(row => {
    doc.fontSize(9.5).font('Helvetica-Bold');
    let maxNameH = 0;
    for (const p of row) maxNameH = Math.max(maxNameH, doc.heightOfString(p.name, { width: colW }));
    doc.fontSize(12).font('Helvetica-Bold');
    const priceLH = doc.currentLineHeight();
    doc.fontSize(8).font('Helvetica');
    const detailLH = doc.currentLineHeight();
    return maxNameH + 3 + priceLH + 2 + detailLH;
  });
}

/** Bloc regroupé, fond clair, pour les produits sans photo exploitable —
 *  jamais un placeholder par carte dans la grille (voir la maquette : les
 *  références sans visuel sont sorties de la grille photo et listées à part,
 *  en texte seul). Le rectangle de fond est tracé AVANT le texte : sa hauteur
 *  doit donc être connue à l'avance (rowHeights, calculées par l'appelant). */
function drawCatalogueNoPhotoBox(
  doc: PDFKit.PDFDocument, y: number, colW: number,
  rows: CatalogueProductInput[][], rowHeights: number[],
): number {
  const pad = 14, gutter = 16, headerH = 34;
  const totalRowsH = rowHeights.reduce((s, h) => s + h + 14, 0);
  const boxH = headerH + totalRowsH + 4;

  doc.roundedRect(CAT_LEFT, y, CAT_WIDTH, boxH, 8).fillColor(CAT_SURFACE).fill();

  const flat = rows.flat();
  doc.fontSize(9).font('Helvetica-Bold').fillColor(CAT_INK)
    .text('ÉGALEMENT AU CATALOGUE', CAT_LEFT + pad, y + 14, { characterSpacing: 0.4, lineBreak: false });
  const label = flat.length > 1
    ? `Visuels indisponibles pour ces ${flat.length} références`
    : 'Visuel indisponible pour cette référence';
  doc.fontSize(8).font('Helvetica').fillColor(CAT_MUTED)
    .text(label, CAT_LEFT + pad, y + 15, { width: CAT_WIDTH - pad * 2, align: 'right', lineBreak: false });

  let ty = y + headerH;
  rows.forEach((row, ri) => {
    const rowH = rowHeights[ri];
    row.forEach((p, i) => {
      const x = CAT_LEFT + pad + i * (colW + gutter);
      let cy = ty;
      doc.fontSize(9.5).font('Helvetica-Bold').fillColor(CAT_INK).text(p.name, x, cy, { width: colW, lineGap: 0 });
      cy += doc.heightOfString(p.name, { width: colW }) + 3;

      doc.fontSize(12).font('Helvetica-Bold');
      const priceLH = doc.currentLineHeight();
      const unitLabel = p.unit ?? 'carton';
      doc.fillColor(CAT_PRIMARY)
        .text(p.cartonPriceHt != null ? euro(p.cartonPriceHt) : '—', x, cy, { continued: true, lineBreak: false });
      doc.fontSize(8).font('Helvetica').fillColor(CAT_MUTED).text(`  HT / ${unitLabel}`, { lineBreak: false });
      cy += priceLH + 2;

      if (p.unitsPerCarton != null) {
        const unitPrice = p.cartonPriceHt != null ? p.cartonPriceHt / p.unitsPerCarton : null;
        const detail = unitPrice != null
          ? `${p.unitsPerCarton} unités · env. ${euro(unitPrice)} HT / unité`
          : `${p.unitsPerCarton} unités / carton`;
        doc.fontSize(8).font('Helvetica').fillColor(CAT_MUTED).text(detail, x, cy, { width: colW, lineBreak: false });
      }
    });
    ty += rowH + 14;
  });

  return y + boxH + 16;
}

function drawCatalogueTermsPage(doc: PDFKit.PDFDocument, editionDateLabel: string): void {
  doc.fontSize(18).font('Helvetica-Bold').fillColor(CAT_PRIMARY).text('CONDITIONS COMMERCIALES', CAT_LEFT, 60);
  doc.moveTo(CAT_LEFT, 90).lineTo(CAT_RIGHT, 90).lineWidth(1).strokeColor(CAT_PRIMARY).stroke();

  let y = 116;
  const section = (title: string, body: string) => {
    doc.fontSize(11).font('Helvetica-Bold').fillColor(CAT_INK).text(title, CAT_LEFT, y, { lineBreak: false });
    y += 18;
    doc.fontSize(9.5).font('Helvetica').fillColor(CAT_MUTED).text(body, CAT_LEFT, y, { width: CAT_WIDTH, lineGap: 3 });
    y += doc.heightOfString(body, { width: CAT_WIDTH, lineGap: 3 }) + 28;
  };

  section('Livraison', 'Livraison sous 48h, partout à La Réunion — du littoral aux hauts, sans exception.');
  section('Commande', `Commandez en ligne à tout moment sur ${COMPANY.siteUrl.replace(/^https?:\/\//, '')}, ou directement auprès de votre interlocuteur commercial Inca Import.`);
  section('Contact', `${COMPANY.phoneDisplay}  ·  ${COMPANY.contactEmail}`);

  doc.fontSize(8).font('Helvetica-Oblique').fillColor(CAT_MUTED)
    .text(
      `Prix HT, hors taxes applicables. Tarifs valables au ${editionDateLabel}, susceptibles de modification.`,
      CAT_LEFT, 700, { width: CAT_WIDTH, align: 'center' },
    );
}

/** Bande de pied de page — reprend l'appel à l'action de la maquette
 *  ("Votre prochaine commande" / site) plutôt que les coordonnées complètes,
 *  déjà présentes en page de garde et n'ayant pas besoin d'être répétées sur
 *  chaque page. */
function finalizeCataloguePages(doc: PDFKit.PDFDocument): void {
  const totalPages = doc.bufferedPageRange().count;
  for (let i = 0; i < totalPages; i++) {
    doc.switchToPage(i);
    if (i === 0) continue; // page de garde : coordonnées déjà au centre, pas de bande de pied redondante
    doc.moveTo(CAT_LEFT, 793).lineTo(CAT_RIGHT, 793).lineWidth(0.5).strokeColor(CAT_BORDER).stroke();
    doc.fontSize(9).font('Helvetica-Bold').fillColor(CAT_INK)
      .text('Votre prochaine commande', CAT_LEFT, 800, { lineBreak: false, height: 20 });
    doc.fontSize(9).font('Helvetica-Bold').fillColor(CAT_PRIMARY)
      .text(COMPANY.siteUrl.replace(/^https?:\/\//, ''), 300, 800, { width: 255, align: 'right', lineBreak: false, height: 20 });
    doc.fontSize(7).font('Helvetica').fillColor(CAT_MUTED)
      .text(`Page ${i + 1} / ${totalPages}`, CAT_LEFT, 813, { width: CAT_WIDTH, align: 'center', lineBreak: false, height: 20 });
  }
  doc.flushPages();
}

export function generateCataloguePDF(data: CataloguePdfData): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      // La bande de pied de page (finalizeCataloguePages) dessine jusqu'à
      // y=822 — une marge basse uniforme de 40 (donc une limite de flux
      // automatique à 802) faisait déclencher la pagination auto de PDFKit à
      // chaque page et gonflait le document de pages fantômes. Marge basse
      // réduite spécifiquement pour laisser ce pied de page dans la zone
      // "hors marge" sans franchir le seuil de saut de page automatique.
      margins: { top: 40, bottom: 15, left: 40, right: 40 }, size: 'A4', bufferPages: true,
      info: {
        Title: `Catalogue produits — ${data.groupLabel}`,
        Author: COMPANY.name,
        Subject: 'Catalogue produits',
        // Jamais de coût/marge ici, ni nulle part ailleurs dans ce document —
        // seuls des prix de vente déjà résolus entrent dans ce module.
      },
    });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    drawCatalogueTopBar(doc);
    drawCatalogueCover(doc, data.groupLabel, data.editionDateLabel);

    doc.addPage();
    drawCatalogueTopBar(doc);
    let y = drawCatalogueRunningHeader(doc, data.groupLabel, data.editionMonthYearLabel);

    const COLS = 3;
    const GUTTER = 16;
    const COL_W = (CAT_WIDTH - GUTTER * (COLS - 1)) / COLS;
    const PHOTO_H = 72;
    const NP_PAD = 14, NP_GUTTER = 16;
    const NP_COL_W = (CAT_WIDTH - NP_PAD * 2 - NP_GUTTER * (COLS - 1)) / COLS;

    const newPage = () => {
      doc.addPage();
      drawCatalogueTopBar(doc);
      y = drawCatalogueRunningHeader(doc, data.groupLabel, data.editionMonthYearLabel);
    };

    // Regroupe en préservant l'ordre déjà trié (catégorie puis nom) fourni
    // par l'appelant — ce module ne trie ni ne filtre rien lui-même.
    const categories: { label: string; products: CatalogueProductInput[] }[] = [];
    for (const p of data.products) {
      const last = categories[categories.length - 1];
      if (last && last.label === p.categoryLabel) last.products.push(p);
      else categories.push({ label: p.categoryLabel, products: [p] });
    }

    for (const { label, products } of categories) {
      const hasPhoto = products.filter(p => p.imageBuffer != null);
      const noPhoto  = products.filter(p => p.imageBuffer == null);

      if (y + 60 > CAT_BOTTOM) newPage();
      y = drawCatalogueCategoryHeader(doc, label, products.length, y);

      for (const row of chunk3(hasPhoto)) {
        const rowH = measureCataloguePhotoRowHeight(doc, row, COL_W, PHOTO_H);
        if (y + rowH > CAT_BOTTOM) {
          newPage();
          y = drawCatalogueContinuationHeader(doc, label, y);
        }
        drawCataloguePhotoRow(doc, row, CAT_LEFT, y, COL_W, GUTTER, PHOTO_H);
        doc.moveTo(CAT_LEFT, y + rowH - 8).lineTo(CAT_RIGHT, y + rowH - 8)
          .lineWidth(0.5).strokeColor(CAT_BORDER).stroke();
        y += rowH;
      }

      if (noPhoto.length > 0) {
        const npRows = chunk3(noPhoto);
        const npRowHeights = measureNoPhotoRowHeights(doc, npRows, NP_COL_W);
        const npBoxH = 34 + npRowHeights.reduce((s, h) => s + h + 14, 0) + 4;
        if (y + npBoxH > CAT_BOTTOM) {
          newPage();
          y = drawCatalogueContinuationHeader(doc, label, y);
        }
        y = drawCatalogueNoPhotoBox(doc, y, NP_COL_W, npRows, npRowHeights);
      } else {
        y += 14; // respiration avant la catégorie suivante
      }
    }

    doc.addPage();
    drawCatalogueTopBar(doc);
    drawCatalogueTermsPage(doc, data.editionDateLabel);

    finalizeCataloguePages(doc);
    doc.end();
  });
}

export interface PdfOrderItem {
  product_name: string;
  quantity: number;
  unit?: string | null;
  price_ht?: number | null;
  tva_rate?: number | null;
}

// Per-item TVA using each line's snapshot rate; missing rates fall back to 8.5%.
function computeTva(items: PdfOrderItem[]): number {
  return items.reduce(
    (s, it) => s + it.quantity * Number(it.price_ht ?? 0) * Number(it.tva_rate ?? DEFAULT_TVA_RATE),
    0,
  );
}

export interface PdfOrderData {
  id: string;
  nom: string;
  societe?: string | null;
  email: string;
  telephone?: string | null;
  points_de_vente?: string | null;
  notes?: string | null;
  items: PdfOrderItem[];
  totalHT: number;
  date: string;
}

export interface DeliveryItem {
  product_name: string;
  quantity: number;
  unit?: string | null;
  sku?: string | null;
  price_ht?: number | null;
  tva_rate?: number | null;
  units_per_carton?: number | null;
}

export interface DeliveryPDV {
  name: string;
  items: DeliveryItem[];
  client_nom?: string | null;
  client_societe?: string | null;
  client_address?: string | null;
  client_facturation_address?: string | null;
}

export interface PdfDeliveryData {
  id: string;
  date: string;
  pdvs: DeliveryPDV[];
  notes?: string | null;
}

const PRIMARY   = '#C96334';
const INK       = '#1E1A16';
const MUTED     = '#706B65';
const SURFACE   = '#F6F3EF';
const ROW_ALT   = '#F2EFE9';   // subtle alternating row tint
const BORDER    = '#E7E2DC';
const WHITE     = '#FFFFFF';
const LIVR_BG   = '#FFF0E6';  // warm tint for livraison block
const LIVR_BORD = '#E8A87C';  // orange border for livraison block
const LIVR_LBL  = '#9B4D1E';  // darker orange for livraison label

const FOOTER_L1 = `${COMPANY.name} · ${COMPANY.addressLine} · ${COMPANY.postalCode} ${COMPANY.city} · SIRET ${COMPANY.siret}`;
const FOOTER_L2 = `${COMPANY.contactEmail} · ${COMPANY.phoneDisplay}`;

export function generateOrderPDF(order: PdfOrderData): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 50, size: 'A4', bufferPages: true, info: { Title: `Commande ${order.id.slice(0, 8).toUpperCase()}`, Author: 'Inca Import' } });
    const chunks: Buffer[] = [];

    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const tva = computeTva(order.items);
    const ttc = order.totalHT + tva;

    // ── Brand header ──────────────────────────────────
    doc.fontSize(22).font('Helvetica-Bold').fillColor(PRIMARY).text('Inca Import', 50, 50);
    doc.fontSize(9).font('Helvetica').fillColor(MUTED).text('Grossiste B2B · La Réunion', 50, 78);

    // Order ref (top right)
    doc.fontSize(8).font('Helvetica').fillColor(MUTED)
      .text(`Ref. : ${order.id.slice(0, 8).toUpperCase()}`, 350, 50, { width: 195, align: 'right' })
      .text(`Date : ${order.date}`, 350, 63, { width: 195, align: 'right' });

    // Divider
    doc.moveTo(50, 98).lineTo(545, 98).lineWidth(0.5).strokeColor(BORDER).stroke();

    // ── Document title ────────────────────────────────
    doc.fontSize(15).font('Helvetica-Bold').fillColor(INK).text('BON DE COMMANDE', 50, 114);

    // ── Client info box ───────────────────────────────
    const boxTop = 144;
    const extraLines = (order.societe ? 1 : 0) + (order.points_de_vente ? 1 : 0);
    const boxH = 75 + extraLines * 14;
    doc.rect(50, boxTop, 495, boxH).fillColor(SURFACE).fill();
    doc.rect(50, boxTop, 495, boxH).lineWidth(0.5).strokeColor(BORDER).stroke();

    doc.fontSize(7).font('Helvetica-Bold').fillColor(MUTED)
      .text('CLIENT', 65, boxTop + 12);

    doc.fontSize(12).font('Helvetica-Bold').fillColor(INK)
      .text(order.nom, 65, boxTop + 26);

    let cy = boxTop + 44;
    if (order.societe) {
      doc.fontSize(9).font('Helvetica').fillColor(MUTED).text(order.societe, 65, cy);
      cy += 14;
    }
    if (order.points_de_vente) {
      doc.fontSize(9).font('Helvetica').fillColor(MUTED).text(`PDV : ${order.points_de_vente}`, 65, cy);
      cy += 14;
    }
    doc.fontSize(9).font('Helvetica').fillColor(MUTED).text(order.email, 65, cy);
    if (order.telephone) {
      doc.fontSize(9).font('Helvetica').fillColor(MUTED).text(order.telephone, 220, cy);
    }

    // ── Products table ────────────────────────────────
    const tTop = boxTop + boxH + 20;
    const cols = { px: 58, ux: 318, qx: 393, hx: 453 };

    // Header row
    doc.rect(50, tTop, 495, 22).fillColor(PRIMARY).fill();
    doc.fontSize(8).font('Helvetica-Bold').fillColor(WHITE)
      .text('PRODUIT',  cols.px, tTop + 7)
      .text('UNITE',    cols.ux, tTop + 7)
      .text('QTE',      cols.qx, tTop + 7, { width: 45, align: 'right' })
      .text('PRIX HT',  cols.hx, tTop + 7, { width: 82, align: 'right' });

    const PAGE_BOTTOM = 740;

    const drawTableHeader = (y: number) => {
      doc.rect(50, y, 495, 22).fillColor(PRIMARY).fill();
      doc.fontSize(8).font('Helvetica-Bold').fillColor(WHITE)
        .text('PRODUIT', cols.px, y + 7)
        .text('UNITE',   cols.ux, y + 7)
        .text('QTE',     cols.qx, y + 7, { width: 45, align: 'right' })
        .text('PRIX HT', cols.hx, y + 7, { width: 82, align: 'right' });
      return y + 22;
    };

    let ry = drawTableHeader(tTop);
    let rowColorIdx = 0;

    for (let i = 0; i < order.items.length; i++) {
      const item  = order.items[i];
      doc.fontSize(9).font('Helvetica');
      const nameH = doc.heightOfString(item.product_name, { width: 252 });
      const rowH  = Math.max(24, Math.ceil(nameH) + 12);

      if (ry + rowH > PAGE_BOTTOM) {
        doc.addPage();
        ry = drawTableHeader(50);
        rowColorIdx = 0;
      }

      doc.rect(50, ry, 495, rowH).fillColor(rowColorIdx % 2 === 0 ? WHITE : SURFACE).fill();
      doc.rect(50, ry, 495, rowH).lineWidth(0.3).strokeColor(BORDER).stroke();

      const lineHT   = item.quantity * Number(item.price_ht ?? 0);
      const priceStr = item.price_ht != null ? `${lineHT.toFixed(2)} EUR` : '-';

      doc.fontSize(9).font('Helvetica').fillColor(INK)
        .text(item.product_name, cols.px, ry + 6, { width: 252 })
        .text(item.unit ?? '-',  cols.ux, ry + 6, { lineBreak: false })
        .text(String(item.quantity), cols.qx, ry + 6, { width: 45, align: 'right', lineBreak: false })
        .text(priceStr, cols.hx, ry + 6, { width: 82, align: 'right', lineBreak: false });

      ry += rowH;
      rowColorIdx++;
    }

    // QTÉ summary row
    const totalQty = order.items.reduce((s, i) => s + i.quantity, 0);
    if (ry + 22 > PAGE_BOTTOM) { doc.addPage(); ry = 50; }
    doc.rect(50, ry, 495, 22).fillColor(SURFACE).fill();
    doc.rect(50, ry, 495, 22).lineWidth(0.3).strokeColor(BORDER).stroke();
    doc.fontSize(8).font('Helvetica-Bold').fillColor(MUTED)
      .text('TOTAL', cols.px, ry + 7)
      .text(String(totalQty), cols.qx, ry + 7, { width: 45, align: 'right' });
    ry += 22;

    // Totals block — keep together, add page if needed
    const totalsH = 76;
    if (ry + 12 + totalsH > PAGE_BOTTOM) { doc.addPage(); ry = 50; }
    ry += 12;

    doc.rect(350, ry, 195, totalsH).fillColor(SURFACE).fill();
    doc.rect(350, ry, 195, totalsH).lineWidth(0.5).strokeColor(BORDER).stroke();

    doc.fontSize(8).font('Helvetica').fillColor(MUTED)
      .text('Total HT',  360, ry + 12)
      .text(`${order.totalHT.toFixed(2)} EUR`, cols.hx, ry + 12, { width: 82, align: 'right' });

    doc.fontSize(8).font('Helvetica').fillColor(MUTED)
      .text('TVA', 360, ry + 30)
      .text(`${tva.toFixed(2)} EUR`, cols.hx, ry + 30, { width: 82, align: 'right' });

    doc.moveTo(360, ry + 46).lineTo(535, ry + 46).lineWidth(0.5).strokeColor(BORDER).stroke();

    doc.fontSize(9).font('Helvetica-Bold').fillColor(INK)
      .text('TOTAL TTC', 360, ry + 54)
      .text(`${ttc.toFixed(2)} EUR`, cols.hx, ry + 54, { width: 82, align: 'right' });

    // Notes
    if (order.notes) {
      ry += totalsH + 20;
      if (ry + 40 > PAGE_BOTTOM) { doc.addPage(); ry = 50; }
      doc.fontSize(7).font('Helvetica-Bold').fillColor(MUTED).text('NOTES', 50, ry);
      doc.fontSize(9).font('Helvetica').fillColor(INK).text(order.notes, 50, ry + 14, { width: 495 });
    }

    // Footer on every page
    const totalPages = doc.bufferedPageRange().count;
    for (let p = 0; p < totalPages; p++) {
      doc.switchToPage(p);
      doc.fontSize(7).font('Helvetica').fillColor(MUTED)
        .text(`${COMPANY.name} · ${COMPANY.contactEmail} · ${COMPANY.phoneDisplay} · ${COMPANY.region}`, 50, 775, { width: 495, align: 'center', lineBreak: false });
    }
    doc.flushPages();
    doc.end();
  });
}

export function generateInvoicePDF(order: PdfOrderData): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 50, size: 'A4', bufferPages: true, info: { Title: `Accuse de reception ${order.id.slice(0, 8).toUpperCase()}`, Author: 'Inca Import' } });
    const chunks: Buffer[] = [];

    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const tva = computeTva(order.items);
    const ttc = order.totalHT + tva;

    // ── Brand header ──────────────────────────────────
    doc.fontSize(22).font('Helvetica-Bold').fillColor(PRIMARY).text('Inca Import', 50, 50);
    doc.fontSize(9).font('Helvetica').fillColor(MUTED)
      .text('Grossiste B2B · La Réunion', 50, 78)
      .text(`${COMPANY.addressLine} — ${COMPANY.postalCode} ${COMPANY.city}`, 50, 93)
      .text(`SIRET ${COMPANY.siret}`, 50, 108);

    // Document title + ref (top right)
    doc.fontSize(16).font('Helvetica-Bold').fillColor(INK)
      .text('ACCUSE DE RECEPTION', 350, 50, { width: 195, align: 'right' });
    doc.fontSize(8).font('Helvetica').fillColor(MUTED)
      .text(`Réf. : ${order.id.slice(0, 8).toUpperCase()}`, 350, 74, { width: 195, align: 'right' })
      .text(`Date : ${order.date}`, 350, 88, { width: 195, align: 'right' });

    // Divider
    doc.moveTo(50, 128).lineTo(545, 128).lineWidth(0.5).strokeColor(BORDER).stroke();

    // ── Client info box ───────────────────────────────
    const boxTop = 148;
    const extraLinesInv = (order.societe ? 1 : 0) + (order.points_de_vente ? 1 : 0);
    const boxH = 75 + extraLinesInv * 14;
    doc.rect(50, boxTop, 495, boxH).fillColor(SURFACE).fill();
    doc.rect(50, boxTop, 495, boxH).lineWidth(0.5).strokeColor(BORDER).stroke();

    doc.fontSize(7).font('Helvetica-Bold').fillColor(MUTED)
      .text('CLIENT', 65, boxTop + 12);

    doc.fontSize(12).font('Helvetica-Bold').fillColor(INK)
      .text(order.nom, 65, boxTop + 26);

    let cy = boxTop + 44;
    if (order.societe) {
      doc.fontSize(9).font('Helvetica').fillColor(MUTED).text(order.societe, 65, cy);
      cy += 14;
    }
    if (order.points_de_vente) {
      doc.fontSize(9).font('Helvetica').fillColor(MUTED).text(`PDV : ${order.points_de_vente}`, 65, cy);
      cy += 14;
    }
    doc.fontSize(9).font('Helvetica').fillColor(MUTED).text(order.email, 65, cy);
    if (order.telephone) {
      doc.fontSize(9).font('Helvetica').fillColor(MUTED).text(order.telephone, 220, cy);
    }

    // ── Products table ────────────────────────────────
    const tTop = boxTop + boxH + 20;
    const cols = { px: 58, ux: 318, qx: 393, hx: 453 };

    const PAGE_BOTTOM = 740;

    const drawInvHeader = (y: number) => {
      doc.rect(50, y, 495, 22).fillColor(PRIMARY).fill();
      doc.fontSize(8).font('Helvetica-Bold').fillColor(WHITE)
        .text('PRODUIT',  cols.px, y + 7)
        .text('UNITE',    cols.ux, y + 7)
        .text('QTE',      cols.qx, y + 7, { width: 45, align: 'right' })
        .text('TOTAL HT', cols.hx, y + 7, { width: 82, align: 'right' });
      return y + 22;
    };

    let ry = drawInvHeader(tTop);
    let rowColorIdx = 0;

    for (let i = 0; i < order.items.length; i++) {
      const item  = order.items[i];
      doc.fontSize(9).font('Helvetica');
      const nameH = doc.heightOfString(item.product_name, { width: 252 });
      const rowH  = Math.max(24, Math.ceil(nameH) + 12);

      if (ry + rowH > PAGE_BOTTOM) {
        doc.addPage();
        ry = drawInvHeader(50);
        rowColorIdx = 0;
      }

      doc.rect(50, ry, 495, rowH).fillColor(rowColorIdx % 2 === 0 ? WHITE : SURFACE).fill();
      doc.rect(50, ry, 495, rowH).lineWidth(0.3).strokeColor(BORDER).stroke();

      const lineHT   = item.quantity * Number(item.price_ht ?? 0);
      const priceStr = item.price_ht != null ? `${lineHT.toFixed(2)} EUR` : '-';

      doc.fontSize(9).font('Helvetica').fillColor(INK)
        .text(item.product_name, cols.px, ry + 6, { width: 252 })
        .text(item.unit ?? '-',  cols.ux, ry + 6, { lineBreak: false })
        .text(String(item.quantity), cols.qx, ry + 6, { width: 45, align: 'right', lineBreak: false })
        .text(priceStr, cols.hx, ry + 6, { width: 82, align: 'right', lineBreak: false });

      ry += rowH;
      rowColorIdx++;
    }

    // QTÉ summary row
    const totalQtyInv = order.items.reduce((s, i) => s + i.quantity, 0);
    if (ry + 22 > PAGE_BOTTOM) { doc.addPage(); ry = 50; }
    doc.rect(50, ry, 495, 22).fillColor(SURFACE).fill();
    doc.rect(50, ry, 495, 22).lineWidth(0.3).strokeColor(BORDER).stroke();
    doc.fontSize(8).font('Helvetica-Bold').fillColor(MUTED)
      .text('TOTAL', cols.px, ry + 7)
      .text(String(totalQtyInv), cols.qx, ry + 7, { width: 45, align: 'right' });
    ry += 22;

    // ── Totals block — keep together ──────────────────
    const totalsH = 76;
    if (ry + 12 + totalsH > PAGE_BOTTOM) { doc.addPage(); ry = 50; }
    ry += 12;

    doc.rect(350, ry, 195, totalsH).fillColor(SURFACE).fill();
    doc.rect(350, ry, 195, totalsH).lineWidth(0.5).strokeColor(BORDER).stroke();

    doc.fontSize(8).font('Helvetica').fillColor(MUTED)
      .text('Total HT',  360, ry + 12)
      .text(`${order.totalHT.toFixed(2)} EUR`, cols.hx, ry + 12, { width: 82, align: 'right' });

    doc.fontSize(8).font('Helvetica').fillColor(MUTED)
      .text('TVA', 360, ry + 30)
      .text(`${tva.toFixed(2)} EUR`, cols.hx, ry + 30, { width: 82, align: 'right' });

    doc.moveTo(360, ry + 46).lineTo(535, ry + 46).lineWidth(0.5).strokeColor(BORDER).stroke();

    doc.fontSize(9).font('Helvetica-Bold').fillColor(INK)
      .text('TOTAL TTC', 360, ry + 54)
      .text(`${ttc.toFixed(2)} EUR`, cols.hx, ry + 54, { width: 82, align: 'right' });

    // Notes
    if (order.notes) {
      ry += totalsH + 20;
      if (ry + 40 > PAGE_BOTTOM) { doc.addPage(); ry = 50; }
      doc.fontSize(7).font('Helvetica-Bold').fillColor(MUTED).text('NOTES', 50, ry);
      doc.fontSize(9).font('Helvetica').fillColor(INK).text(order.notes, 50, ry + 14, { width: 495 });
    }

    // Footer on every page
    const totalPagesInv = doc.bufferedPageRange().count;
    for (let p = 0; p < totalPagesInv; p++) {
      doc.switchToPage(p);
      doc.fontSize(7).font('Helvetica').fillColor(MUTED)
        .text(`${COMPANY.name} · SIRET ${COMPANY.siret} · ${COMPANY_ADDRESS_LINE}`, 50, 760, { width: 495, align: 'center', lineBreak: false })
        .text(`${COMPANY.contactEmail} · ${COMPANY.phoneDisplay}`, 50, 772, { width: 495, align: 'center', lineBreak: false });
    }
    doc.flushPages();
    doc.end();
  });
}

// ── Shared PDF helpers ─────────────────────────────────────────────────────

function drawHeader(doc: InstanceType<typeof PDFDocument>, opts: {
  id: string; date: string; title: string; withAddress?: boolean;
}) {
  // Brand name — larger and bolder
  doc.fontSize(26).font('Helvetica-Bold').fillColor(PRIMARY).text('Inca Import', 50, 44);
  // Coral accent line under brand name
  doc.moveTo(50, 80).lineTo(168, 80).lineWidth(2.5).strokeColor(PRIMARY).stroke();

  doc.fontSize(8).font('Helvetica').fillColor(MUTED)
    .text(`Réf. : ${opts.id}`, 350, 44, { width: 195, align: 'right' })
    .text(`Date : ${opts.date}`, 350, 57, { width: 195, align: 'right' });

  if (opts.withAddress) {
    doc.fontSize(8.5).font('Helvetica').fillColor(MUTED)
      .text(`${COMPANY.addressLine} — ${COMPANY.postalCode} ${COMPANY.city}`, 50, 90)
      .text(`SIRET ${COMPANY.siret}`, 50, 103);
    doc.moveTo(50, 120).lineTo(545, 120).lineWidth(0.5).strokeColor(BORDER).stroke();
    doc.fontSize(15).font('Helvetica-Bold').fillColor(INK).text(opts.title, 50, 134);
    return 134 + 32;
  } else {
    doc.fontSize(8.5).font('Helvetica').fillColor(MUTED).text('Grossiste B2B · La Réunion', 50, 90);
    doc.moveTo(50, 106).lineTo(545, 106).lineWidth(0.5).strokeColor(BORDER).stroke();
    doc.fontSize(15).font('Helvetica-Bold').fillColor(INK).text(opts.title, 50, 120);
    return 120 + 32;
  }
}

function drawProductTable(
  doc: InstanceType<typeof PDFDocument>,
  items: { product_name: string; quantity: number; unit?: string | null }[],
  startY: number,
): number {
  let y = startY;
  const cols = { px: 65, ux: 380, qx: 480 };

  // Header row
  doc.rect(50, y, 495, 22).fillColor(SURFACE).fill();
  doc.moveTo(50, y + 22).lineTo(545, y + 22).lineWidth(0.5).strokeColor(BORDER).stroke();
  doc.fontSize(7).font('Helvetica-Bold').fillColor(MUTED)
    .text('PRODUIT', cols.px, y + 8)
    .text('UNITÉ',   cols.ux, y + 8)
    .text('QTÉ',     cols.qx, y + 8, { width: 55, align: 'right' });
  y += 22;

  doc.fontSize(9).font('Helvetica');
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    // Dynamic row height: measure wrapped product name
    const nameH = doc.heightOfString(item.product_name, { width: 305 });
    const rowH  = Math.max(22, Math.ceil(nameH) + 10);
    if (y + rowH > 755) { doc.addPage(); y = 50; }
    if (i % 2 === 1) {
      doc.rect(50, y, 495, rowH).fillColor(ROW_ALT).fill();
    }
    doc.moveTo(50, y + rowH).lineTo(545, y + rowH).lineWidth(0.3).strokeColor(BORDER).stroke();
    doc.fillColor(INK)
      .text(item.product_name, cols.px, y + 5, { width: 305 })
      .text(item.unit ?? '—',  cols.ux, y + 5)
      .text(String(item.quantity), cols.qx, y + 5, { width: 55, align: 'right' });
    y += rowH;
  }
  return y;
}

function drawTotalCartons(doc: InstanceType<typeof PDFDocument>, total: number, y: number): number {
  y += 8;
  doc.rect(50, y, 495, 32).fillColor(PRIMARY).fill();
  doc.fontSize(8.5).font('Helvetica-Bold').fillColor(WHITE).text('TOTAL CARTONS', 65, y + 11);
  doc.fontSize(14).font('Helvetica-Bold').fillColor(WHITE)
    .text(String(total), 350, y + 9, { width: 180, align: 'right' });
  return y + 32;
}

function finalizeDoc(doc: InstanceType<typeof PDFDocument>): void {
  const totalPages = doc.bufferedPageRange().count;

  for (let i = 0; i < totalPages; i++) {
    doc.switchToPage(i);
    if (totalPages > 1) {
      doc.fontSize(7).font('Helvetica').fillColor(MUTED)
        .text(`Page ${i + 1} / ${totalPages}`, 400, 755, { width: 145, align: 'right', lineBreak: false });
    }
    if (i === totalPages - 1) {
      doc.fontSize(7).font('Helvetica').fillColor(MUTED)
        .text(FOOTER_L1, 50, 760, { width: 495, align: 'center', lineBreak: false });
      doc.fontSize(7).font('Helvetica').fillColor(MUTED)
        .text(FOOTER_L2, 50, 772, { width: 495, align: 'center', lineBreak: false });
    }
  }

  doc.flushPages();
}

// ── Summary PDF: all PDVs + consolidated products ─────────────────────────

export function generateDeliverySummaryPDF(delivery: PdfDeliveryData): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 50, size: 'A4', bufferPages: true, info: { Title: `Récapitulatif ${delivery.id}`, Author: 'Inca Import' } });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    let y = drawHeader(doc, {
      id: delivery.id, date: delivery.date,
      title: 'RÉCAPITULATIF DE LIVRAISON',
      withAddress: true,
    });

    y += 16;

    // ── PDV list ──────────────────────────────────────
    const pdvCount = delivery.pdvs.length;
    doc.rect(50, y, 495, 26).fillColor(PRIMARY).fill();
    doc.fontSize(9).font('Helvetica-Bold').fillColor(WHITE)
      .text(`${pdvCount} POINT${pdvCount > 1 ? 'S' : ''} DE VENTE`, 65, y + 8);
    y += 26;

    for (let i = 0; i < delivery.pdvs.length; i++) {
      if (y > 755) { doc.addPage(); y = 50; }
      doc.rect(50, y, 495, 20).fillColor(i % 2 === 0 ? WHITE : SURFACE).fill();
      doc.rect(50, y, 495, 20).lineWidth(0.3).strokeColor(BORDER).stroke();
      doc.fontSize(9).font('Helvetica').fillColor(INK)
        .text(`${i + 1}.`, 65, y + 6, { width: 24 })
        .text(delivery.pdvs[i].name, 90, y + 6, { width: 380 });
      const pdvTotal = delivery.pdvs[i].items.reduce((s, it) => s + it.quantity, 0);
      doc.fontSize(8).font('Helvetica').fillColor(MUTED)
        .text(`${pdvTotal} crt`, 480, y + 7, { width: 55, align: 'right' });
      y += 20;
    }
    y += 20;

    // ── Consolidated products ─────────────────────────
    const consolidated = new Map<string, { unit: string | null; qty: number }>();
    for (const pdv of delivery.pdvs) {
      for (const item of pdv.items) {
        const prev = consolidated.get(item.product_name);
        if (prev) prev.qty += item.quantity;
        else consolidated.set(item.product_name, { unit: item.unit ?? null, qty: item.quantity });
      }
    }
    const consolidatedItems = Array.from(consolidated.entries())
      .map(([name, { unit, qty }]) => ({ product_name: name, unit, quantity: qty }))
      .sort((a, b) => a.product_name.localeCompare(b.product_name, 'fr'));
    const grandTotal = consolidatedItems.reduce((s, i) => s + i.quantity, 0);

    if (y + 46 + consolidatedItems.length * 22 > 755) { doc.addPage(); y = 50; }

    doc.rect(50, y, 495, 26).fillColor(INK).fill();
    doc.fontSize(9).font('Helvetica-Bold').fillColor(WHITE)
      .text('PRODUITS CONSOLIDÉS', 65, y + 8)
      .text(`${grandTotal} cartons au total`, 350, y + 8, { width: 180, align: 'right' });
    y += 26;

    y = drawProductTable(doc, consolidatedItems, y);
    y = drawTotalCartons(doc, grandTotal, y);

    // ── Notes ─────────────────────────────────────────
    if (delivery.notes) {
      y += 20;
      if (y > 720) { doc.addPage(); y = 50; }
      doc.fontSize(7).font('Helvetica-Bold').fillColor(MUTED).text('NOTES', 50, y);
      doc.fontSize(9).font('Helvetica').fillColor(INK).text(delivery.notes, 50, y + 14, { width: 495 });
    }

    finalizeDoc(doc);
    doc.end();
  });
}

// ── Per-PDV PDF: legal Bon de Livraison ──────────────────────────────────

export function generatePDVDeliveryPDF(
  pdv: DeliveryPDV, blNumber: string, date: string
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 50, size: 'A4', bufferPages: true, info: { Title: `${blNumber} — ${pdv.name}`, Author: 'Inca Import' } });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    const SIG_H      = 95;  // signature block height
    const PAGE_BOTTOM = 640; // leave room for signatures + footer on every page

    // Column positions — DÉSIGNATION | U/CARTON | QTÉ | TOTAL UNITÉS
    const col = { desc: 58, descW: 240, upc: 300, upcW: 70, qty: 372, qtyW: 65, tot: 439, totW: 98 };

    // ── Header ─────────────────────────────────────────────────────────────
    doc.fontSize(20).font('Helvetica-Bold').fillColor(PRIMARY)
      .text('BON DE LIVRAISON', 50, 50, { lineBreak: false });
    doc.fontSize(9).font('Helvetica-Bold').fillColor(INK)
      .text(blNumber, 350, 50, { width: 195, align: 'right', lineBreak: false });
    doc.fontSize(8).font('Helvetica').fillColor(MUTED)
      .text(`Date : ${date}`, 350, 65, { width: 195, align: 'right', lineBreak: false });

    doc.moveTo(50, 84).lineTo(545, 84).lineWidth(0.5).strokeColor(BORDER).stroke();

    // ── Two-row info block ─────────────────────────────────────────────────
    const infoY  = 94;
    const row1H  = 76;
    const row2H  = 68;
    const halfW  = 237;
    const rightX = 50 + halfW + 8;
    const rightW = 495 - halfW - 8;
    const row2Y  = infoY + row1H + 6;

    // Row 1 left: Fournisseur
    doc.rect(50, infoY, halfW, row1H).fillColor(SURFACE).fill();
    doc.rect(50, infoY, halfW, row1H).lineWidth(0.5).strokeColor(BORDER).stroke();
    doc.fontSize(7).font('Helvetica-Bold').fillColor(MUTED)
      .text('FOURNISSEUR', 62, infoY + 10, { lineBreak: false });
    doc.fontSize(10).font('Helvetica-Bold').fillColor(INK)
      .text('Inca Import', 62, infoY + 22, { lineBreak: false });
    doc.fontSize(8).font('Helvetica').fillColor(MUTED)
      .text(COMPANY.addressLine, 62, infoY + 37, { lineBreak: false })
      .text(`${COMPANY.postalCode} ${COMPANY.city}, ${COMPANY.region}`, 62, infoY + 50, { lineBreak: false })
      .text(`SIRET : ${COMPANY.siret}`, 62, infoY + 63, { lineBreak: false });

    // Row 1 right: Client — société as primary name, nom as contact line
    const displayName = pdv.client_societe ?? pdv.client_nom ?? pdv.name;
    const displayContact = pdv.client_societe && pdv.client_nom ? pdv.client_nom : null;
    doc.rect(rightX, infoY, rightW, row1H).fillColor(SURFACE).fill();
    doc.rect(rightX, infoY, rightW, row1H).lineWidth(0.5).strokeColor(BORDER).stroke();
    doc.fontSize(7).font('Helvetica-Bold').fillColor(MUTED)
      .text('CLIENT', rightX + 12, infoY + 10, { lineBreak: false });
    doc.fontSize(11).font('Helvetica-Bold').fillColor(INK)
      .text(displayName, rightX + 12, infoY + 22, { width: rightW - 24, lineBreak: false });
    if (displayContact) {
      doc.fontSize(8).font('Helvetica').fillColor(MUTED)
        .text(displayContact, rightX + 12, infoY + 39, { width: rightW - 24, lineBreak: false });
    }

    // Row 2 left: Adresse de facturation
    doc.rect(50, row2Y, halfW, row2H).fillColor(SURFACE).fill();
    doc.rect(50, row2Y, halfW, row2H).lineWidth(0.5).strokeColor(BORDER).stroke();
    doc.fontSize(7).font('Helvetica-Bold').fillColor(MUTED)
      .text('FACTURATION', 62, row2Y + 10, { lineBreak: false });
    doc.fontSize(8).font('Helvetica').fillColor(MUTED)
      .text(pdv.client_facturation_address ?? '—', 62, row2Y + 23, { width: halfW - 24 });

    // Row 2 right: Lieu de livraison (orange tint)
    doc.rect(rightX, row2Y, rightW, row2H).fillColor(LIVR_BG).fill();
    doc.rect(rightX, row2Y, rightW, row2H).lineWidth(0.5).strokeColor(LIVR_BORD).stroke();
    doc.fontSize(7).font('Helvetica-Bold').fillColor(LIVR_LBL)
      .text('LIEU DE LIVRAISON', rightX + 12, row2Y + 10, { lineBreak: false });
    doc.fontSize(9).font('Helvetica-Bold').fillColor(INK)
      .text(pdv.name, rightX + 12, row2Y + 23, { width: rightW - 24, lineBreak: false });
    if (pdv.client_address) {
      doc.fontSize(8).font('Helvetica').fillColor(MUTED)
        .text(pdv.client_address, rightX + 12, row2Y + 37, { width: rightW - 24, lineBreak: false });
    }

    // ── Product table ──────────────────────────────────────────────────────
    let ry = row2Y + row2H + 15;

    const drawBLHeader = (y: number) => {
      doc.rect(50, y, 495, 22).fillColor(PRIMARY).fill();
      doc.fontSize(7.5).font('Helvetica-Bold').fillColor(WHITE)
        .text('DÉSIGNATION',   col.desc, y + 7, { width: col.descW, lineBreak: false })
        .text('U/CARTON',      col.upc,  y + 7, { width: col.upcW,  align: 'right', lineBreak: false })
        .text('QTÉ CARTONS',   col.qty,  y + 7, { width: col.qtyW,  align: 'right', lineBreak: false })
        .text('TOTAL UNITÉS',  col.tot,  y + 7, { width: col.totW,  align: 'right', lineBreak: false });
      return y + 22;
    };

    ry = drawBLHeader(ry);
    let rowColorIdx = 0;
    let totalQty   = 0;
    let totalUnits = 0;
    let allHaveUpc = true;

    for (const item of pdv.items) {
      doc.fontSize(8.5).font('Helvetica');
      const nameH = doc.heightOfString(item.product_name, { width: col.descW });
      const skuH  = item.sku ? 11 : 0;
      const rowH  = Math.max(24, Math.ceil(nameH) + skuH + 10);

      if (ry + rowH > PAGE_BOTTOM) {
        doc.addPage();
        ry = drawBLHeader(50);
        rowColorIdx = 0;
      }

      doc.rect(50, ry, 495, rowH).fillColor(rowColorIdx % 2 === 0 ? WHITE : SURFACE).fill();
      doc.rect(50, ry, 495, rowH).lineWidth(0.3).strokeColor(BORDER).stroke();

      totalQty += item.quantity;
      if (item.units_per_carton != null) totalUnits += item.quantity * item.units_per_carton;
      else allHaveUpc = false;

      doc.fontSize(8.5).font('Helvetica').fillColor(INK)
        .text(item.product_name, col.desc, ry + 6, { width: col.descW, lineBreak: false });
      if (item.sku) {
        doc.fontSize(7).font('Helvetica').fillColor(MUTED)
          .text(`Réf. ${item.sku}`, col.desc, ry + 6 + Math.ceil(nameH), { width: col.descW, lineBreak: false });
      }

      const upc    = item.units_per_carton ?? null;
      const upcStr = upc != null ? String(upc) : '—';
      const totStr = upc != null ? String(item.quantity * upc) : '—';

      doc.fontSize(8.5).font('Helvetica').fillColor(INK)
        .text(upcStr,               col.upc, ry + 6, { width: col.upcW, align: 'right', lineBreak: false })
        .text(String(item.quantity), col.qty, ry + 6, { width: col.qtyW, align: 'right', lineBreak: false })
        .text(totStr,               col.tot, ry + 6, { width: col.totW, align: 'right', lineBreak: false });

      ry += rowH;
      rowColorIdx++;
    }

    // Total row
    if (ry + 22 > PAGE_BOTTOM) { doc.addPage(); ry = 50; }
    doc.rect(50, ry, 495, 22).fillColor(SURFACE).fill();
    doc.rect(50, ry, 495, 22).lineWidth(0.3).strokeColor(BORDER).stroke();
    doc.fontSize(8).font('Helvetica-Bold').fillColor(MUTED)
      .text('TOTAUX', col.desc, ry + 7, { width: col.descW, lineBreak: false })
      .text(String(totalQty), col.qty, ry + 7, { width: col.qtyW, align: 'right', lineBreak: false })
      .text(allHaveUpc ? String(totalUnits) : '—', col.tot, ry + 7, { width: col.totW, align: 'right', lineBreak: false });
    ry += 22;

    // ── Signature block ────────────────────────────────────────────────────
    // Ensure it fits on the current page; if not, open a new one
    if (ry + 28 + SIG_H > PAGE_BOTTOM + SIG_H + 10) { doc.addPage(); ry = 50; }
    ry += 28;

    const sigBoxW = 234;
    const sigGap  = 27;
    const sigR    = 50 + sigBoxW + sigGap; // x of second box

    const drawSigBox = (x: number, label: string) => {
      doc.rect(x, ry, sigBoxW, SIG_H).lineWidth(0.5).strokeColor(BORDER).fillAndStroke(SURFACE, BORDER);
      doc.fontSize(6.5).font('Helvetica-Bold').fillColor(MUTED)
        .text(label, x + 12, ry + 10, { width: sigBoxW - 24, lineBreak: false });
      // Date line near bottom
      doc.fontSize(8).font('Helvetica').fillColor(MUTED)
        .text('Date :', x + 12, ry + SIG_H - 22, { lineBreak: false });
      doc.moveTo(x + 42, ry + SIG_H - 13).lineTo(x + sigBoxW - 12, ry + SIG_H - 13)
        .lineWidth(0.4).strokeColor(BORDER).stroke();
    };

    drawSigBox(50,   'SIGNATURE TRANSPORTEUR');
    drawSigBox(sigR, 'SIGNATURE DESTINATAIRE');

    // Footer on every page
    const totalPages = doc.bufferedPageRange().count;
    for (let p = 0; p < totalPages; p++) {
      doc.switchToPage(p);
      if (totalPages > 1) {
        doc.fontSize(7).font('Helvetica').fillColor(MUTED)
          .text(`Page ${p + 1} / ${totalPages}`, 400, 755, { width: 145, align: 'right', lineBreak: false });
      }
      doc.fontSize(7).font('Helvetica').fillColor(MUTED)
        .text(`${COMPANY.name} · SIRET ${COMPANY.siret} · ${COMPANY_ADDRESS_LINE}`, 50, 760, { width: 495, align: 'center', lineBreak: false })
        .text(`${COMPANY.contactEmail} · ${COMPANY.phoneDisplay}`, 50, 772, { width: 495, align: 'center', lineBreak: false });
    }
    doc.flushPages();
    doc.end();
  });
}
