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
// Troisième direction graphique : couverture commerciale (logo + titre +
// mosaïque de photos, sans donnée administrative) puis grille STRICTE de 9
// fiches par page (3×3) — chaque emplacement a une hauteur fixe calculée une
// fois pour la page entière, jamais mesurée fiche par fiche, pour que les
// prix et conditionnements restent alignés sur toute la rangée quelle que
// soit la longueur du nom. Gabarit fixe et déterministe — aucun appel IA à
// la génération.

export interface CatalogueProductInput {
  id: string;
  name: string;
  category: string;
  categoryLabel: string;
  unit: string | null;
  unitsPerCarton: number | null;
  /** Prix carton déjà résolu (groupe tarifaire, sinon prix de base) — jamais
   *  recalculé ici. Le prix unitaire affiché en dérive (÷ unitsPerCarton),
   *  jamais l'inverse : le prix carton enregistré reste la seule source, ce
   *  document n'en est qu'une présentation. Null seulement si le produit n'a
   *  aucun prix HT enregistré (anomalie, affichée "—", jamais 0). */
  cartonPriceHt: number | null;
  /** Image déjà téléchargée, recadrée et redimensionnée en JPEG (PDFKit ne
   *  lit pas le WebP) — null = pas d'image ou téléchargement/format en échec.
   *  Jamais bloquant et jamais retiré du catalogue : la fiche reste affichée,
   *  compacte, sans cadre vide ni texte technique (voir drawCatalogueCard). */
  imageBuffer: Buffer | null;
}

export interface CataloguePdfData {
  /** Grille tarifaire utilisée pour résoudre les prix (métadonnées PDF
   *  uniquement — jamais affiché dans les pages, voir le brief "prix
   *  unitaire dominant, sans nom de grille"). */
  groupLabel: string;
  /** Déjà filtrés (catégories, disponibilité) et triés (catégorie puis nom)
   *  par l'appelant — ce module se contente de les disposer, dans cet ordre,
   *  en grille continue de 9 par page. */
  products: CatalogueProductInput[];
}

/** Anomalie détectée pendant la génération (jamais affichée dans le PDF) —
 *  à remonter à l'administrateur en dehors du document, jamais comme un
 *  encadré ou une explication technique côté client. */
export interface CatalogueGenerationIssue {
  productId: string;
  productName: string;
  kind: 'missing_image' | 'missing_price' | 'missing_units';
}

const CAT_PRIMARY = '#C96334';
const CAT_INK     = '#1E1A16';
const CAT_MUTED   = '#5C5650';
const CAT_BORDER  = '#E2DDD6';

const CAT_PAGE_W  = 595;
const CAT_LEFT    = 35;
const CAT_RIGHT   = 560;
const CAT_WIDTH   = CAT_RIGHT - CAT_LEFT; // 525
const CAT_BOTTOM  = 795;
const CONTENT_TOP = 58;
const ROW_H       = (CAT_BOTTOM - CONTENT_TOP) / 3;

const COLS   = 3;
const GUTTER = 16;
const COL_W  = (CAT_WIDTH - GUTTER * (COLS - 1)) / COLS;
const PHOTO_H = 141; // ~49.7 mm - dans la fourchette 45-50 mm demandee

// Proportions reelles du fichier logo (745x418px) - preservees a chaque
// usage, seule la hauteur cible change entre l'en-tete courant et la
// couverture.
const LOGO_ASPECT = 745 / 418;

function euro(n: number): string {
  // Meme regle d'arrondi que le reste du site (admin/tarifs/[id].astro,
  // formatEuro) - volontairement `toFixed`, pas un arrondi decimal maison :
  // la coherence avec le prix affiche ailleurs prime sur une regle
  // "ideale" differente.
  return `${n.toFixed(2).replace('.', ',')} €`;
}

/** Empeche la coupure entre un nombre et son unite ("500" / "ml") lors du
 *  retour a la ligne - espace insecable, jamais un retrait du nom. */
function keepUnitsTogether(text: string): string {
  return text.replace(/(\d+(?:[.,]\d+)?)\s+(ml|cl|dl|l|g|kg|mg)\b/gi, '$1 $2');
}

/** Retire un suffixe de conditionnement manifestement redondant ("*24",
 *  "*20"...) - le carton est deja indique sous le prix. Purement cosmetique :
 *  jamais applique au nom enregistre en base, seulement a l'affichage, et
 *  seulement quand l'asterisque est un token separe (jamais "5*32", qui fait
 *  partie du nom lui-meme et distingue une reference differente). */
function stripRedundantPackSuffix(name: string): string {
  return name.replace(/ \*\d+$/, '').trim();
}

/** Tronque `text` pour tenir sur `maxLines` lignes a `width`, avec « ... ».
 *  La grille etant a hauteur de rangee FIXE (9 par page, priorite absolue),
 *  un nom trop long doit s'adapter plutot que casser l'alignement - jamais
 *  un caractere coupe au ras du cadre, toujours une ellipse propre.
 *  Police/taille doivent deja etre posees sur `doc` avant l'appel. */
function fitToLines(doc: PDFKit.PDFDocument, text: string, width: number, maxLines: number): string {
  // includeGap:true — sans ça, la valeur ne correspond pas à la hauteur par
  // ligne réellement utilisée par heightOfString() pour empiler du texte
  // multiligne, et le budget calculé ici serait trop court : des noms tenant
  // réellement sur 2 lignes se retrouvaient tronqués à tort (deux références
  // différentes affichant alors le même nom coupé).
  const lineH = doc.currentLineHeight(true);
  const maxH = lineH * maxLines + 0.5;
  if (doc.heightOfString(text, { width }) <= maxH) return text;

  let lo = 0, hi = text.length, best = text.slice(0, 1) + '…';
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    const candidate = text.slice(0, mid).trimEnd() + '…';
    if (doc.heightOfString(candidate, { width }) <= maxH) { best = candidate; lo = mid + 1; }
    else hi = mid - 1;
  }
  return best;
}

/** Nom pret a l'affichage : suffixe redondant retire, nombre+unite proteges,
 *  puis tenu sur 2 lignes. Doit etre appele avec fontSize(11)/Helvetica deja
 *  poses sur `doc` (fitToLines mesure avec l'etat courant). */
function prepareDisplayName(doc: PDFKit.PDFDocument, rawName: string, width: number): string {
  const cleaned = keepUnitsTogether(stripRedundantPackSuffix(rawName));
  return fitToLines(doc, cleaned, width, 2);
}

/** En-tete minimal repete sur chaque page produit : le vrai logo (ressource
 *  embarquee, voir lib/incaLogoBase64.ts) et, seul texte, "catalogue
 *  professionnel 2026" - aucune date, grille, coordonnee ou titre de
 *  categorie. La grille compte sur une hauteur d'en-tete constante (voir
 *  CONTENT_TOP) pour rester a hauteur fixe. */
function drawCatalogueHeader(doc: PDFKit.PDFDocument, logoBuffer: Buffer | null): void {
  if (logoBuffer) {
    try {
      doc.image(logoBuffer, CAT_LEFT, 14, { height: 24 });
    } catch {
      // Ressource embarquee corrompue (ne devrait jamais arriver) - repli
      // texte plutot que de faire echouer tout le document.
      doc.fontSize(13).font('Helvetica-Bold').fillColor(CAT_INK).text('Inca Import', CAT_LEFT, 18, { lineBreak: false });
    }
  } else {
    doc.fontSize(13).font('Helvetica-Bold').fillColor(CAT_INK).text('Inca Import', CAT_LEFT, 18, { lineBreak: false });
  }

  doc.fontSize(10).font('Helvetica').fillColor(CAT_INK)
    .text('catalogue professionnel 2026', 300, 21, { width: CAT_RIGHT - 300, align: 'right', lineBreak: false });

  doc.moveTo(CAT_LEFT, 46).lineTo(CAT_RIGHT, 46).lineWidth(0.5).strokeColor(CAT_BORDER).stroke();
}

/** Selection deterministe (aucun hasard, aucune IA) de 4 a 6 produits
 *  photographies pour la mosaique de couverture, en visant la diversite de
 *  familles demandee (boisson "simple", boisson proteinee, snack,
 *  confiserie, chips, divers) plutot que l'ordre brut du catalogue. Se
 *  degrade proprement si une famille est absente de la selection en cours
 *  (catalogue filtre a une seule categorie, par exemple). */
function pickCoverProducts(products: CatalogueProductInput[]): CatalogueProductInput[] {
  const withPhoto = products.filter(p => p.imageBuffer != null);
  const isProteinBoisson = (p: CatalogueProductInput) =>
    p.category === 'boissons' && /prot[ée]in|milkshake/i.test(p.name);

  const candidates = [
    withPhoto.find(p => p.category === 'boissons' && !isProteinBoisson(p)),
    withPhoto.find(isProteinBoisson),
    withPhoto.find(p => p.category === 'snacks'),
    withPhoto.find(p => p.category === 'confiseries'),
    withPhoto.find(p => p.category === 'chips'),
    withPhoto.find(p => p.category === 'divers'),
  ];

  const seen = new Set<string>();
  const picked: CatalogueProductInput[] = [];
  for (const p of candidates) {
    if (p && !seen.has(p.id)) { picked.push(p); seen.add(p.id); }
  }
  for (const p of withPhoto) {
    if (picked.length >= 5) break;
    if (!seen.has(p.id)) { picked.push(p); seen.add(p.id); }
  }
  return picked.slice(0, 6);
}

/** Emplacements fixes de la mosaique - tailles variees, disposition aeree et
 *  asymetrique deliberement differente de la grille des fiches (voir brief :
 *  "sans reprendre la grille des fiches"). */
const COVER_SLOTS: { x: number; y: number; w: number; h: number }[] = [
  { x: 222.5, y: 280, w: 150, h: 170 },
  { x: 100,   y: 310, w: 110, h: 130 },
  { x: 385,   y: 305, w: 110, h: 130 },
  { x: 40,    y: 450, w: 85,  h: 100 },
  { x: 470,   y: 450, w: 85,  h: 100 },
  { x: 252.5, y: 520, w: 90,  h: 90  },
];

/** Couverture commerciale : fond blanc, logo reel bien visible, titre en
 *  grand, mosaique de 4-6 vraies photos de produits, une touche de corail
 *  (issue du logo) en accent. Aucun prix, aucun slogan, aucune donnee
 *  administrative - voir le brief "evoquer une selection de produits". */
function drawCatalogueCoverPage(
  doc: PDFKit.PDFDocument, logoBuffer: Buffer | null, coverProducts: CatalogueProductInput[],
): void {
  if (logoBuffer) {
    try {
      const logoH = 90;
      doc.image(logoBuffer, (CAT_PAGE_W - logoH * LOGO_ASPECT) / 2, 55, { height: logoH });
    } catch {
      doc.fontSize(30).font('Helvetica-Bold').fillColor(CAT_INK)
        .text('Inca Import', 0, 85, { width: CAT_PAGE_W, align: 'center' });
    }
  } else {
    doc.fontSize(30).font('Helvetica-Bold').fillColor(CAT_INK)
      .text('Inca Import', 0, 85, { width: CAT_PAGE_W, align: 'center' });
  }

  doc.fontSize(32).font('Helvetica-Bold').fillColor(CAT_INK)
    .text('catalogue professionnel 2026', 30, 188, { width: CAT_PAGE_W - 60, align: 'center', characterSpacing: 0.3 });

  const ruleW = 60;
  doc.moveTo(CAT_PAGE_W / 2 - ruleW / 2, 242).lineTo(CAT_PAGE_W / 2 + ruleW / 2, 242)
    .lineWidth(2.5).strokeColor(CAT_PRIMARY).stroke();

  coverProducts.forEach((p, i) => {
    const slot = COVER_SLOTS[i];
    if (!slot || !p.imageBuffer) return;
    try {
      doc.image(p.imageBuffer, slot.x, slot.y, { fit: [slot.w, slot.h], align: 'center', valign: 'center' });
    } catch { /* photo illisible malgre la normalisation - case laissee vide, jamais bloquant */ }
  });
}

/** Une fiche produit, a une position FIXE (row/col determinent x/y - jamais
 *  mesuree individuellement) : grande photo (ou rien - jamais un cadre
 *  vide), nom centre sur 2 lignes maximum, prix unitaire HT en gros centre,
 *  conditionnement carton centre. Comme toutes les fiches d'une meme rangee
 *  partagent les memes offsets fixes (nameY/priceY/cartonY, calcules une
 *  fois pour tout le document), prix et conditionnements restent alignes
 *  horizontalement meme quand les noms ont des longueurs differentes. */
function drawCatalogueCard(
  doc: PDFKit.PDFDocument, p: CatalogueProductInput,
  x: number, rowY: number, geom: { nameBlockH: number; priceLineH: number },
): void {
  if (p.imageBuffer) {
    try {
      // Calee en bas (valign bottom) pour un effet "etagere" coherent entre
      // bouteilles hautes et paquets plus courts - le produit garde ses
      // propres proportions (fit = contain, jamais deforme ni recadre ici :
      // le recadrage des marges vides est deja fait en amont, voir
      // catalogueImages.ts).
      doc.image(p.imageBuffer, x, rowY, { fit: [COL_W, PHOTO_H], align: 'center', valign: 'bottom' });
    } catch { /* image corrompue malgre la normalisation - fiche compacte, jamais bloquant */ }
  }

  const nameY = rowY + PHOTO_H + 8;
  doc.fontSize(11).font('Helvetica').fillColor(CAT_INK);
  const name = prepareDisplayName(doc, p.name, COL_W);
  doc.text(name, x, nameY, { width: COL_W, align: 'center', lineGap: 0 });

  const priceY = nameY + geom.nameBlockH + 6;
  const unitPrice = p.cartonPriceHt != null && p.unitsPerCarton ? p.cartonPriceHt / p.unitsPerCarton : null;
  const priceStr = unitPrice != null ? euro(unitPrice) : '—';

  doc.fontSize(25).font('Helvetica-Bold');
  const priceW = doc.widthOfString(priceStr);
  doc.fontSize(9.5).font('Helvetica');
  const htStr = '  HT / unité';
  const htW = doc.widthOfString(htStr);
  const comboX = x + (COL_W - (priceW + htW)) / 2;

  doc.fontSize(25).font('Helvetica-Bold').fillColor(CAT_PRIMARY)
    .text(priceStr, comboX, priceY, { lineBreak: false });
  doc.fontSize(9.5).font('Helvetica').fillColor(CAT_MUTED)
    .text(htStr, comboX + priceW, priceY + 12, { lineBreak: false });

  const cartonY = priceY + geom.priceLineH + 5;
  if (p.unitsPerCarton != null) {
    doc.fontSize(9.5).font('Helvetica').fillColor(CAT_MUTED)
      .text(`Carton de ${p.unitsPerCarton} unité${p.unitsPerCarton > 1 ? 's' : ''}`, x, cartonY, { width: COL_W, align: 'center', lineBreak: false });
  }
}

export function generateCataloguePDF(
  data: CataloguePdfData,
  logoBuffer: Buffer | null,
): Promise<{ buffer: Buffer; issues: CatalogueGenerationIssue[] }> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      margin: 35, size: 'A4', bufferPages: true,
      info: {
        Title: `Catalogue produits — ${data.groupLabel}`,
        Author: COMPANY.name,
        Subject: 'Catalogue produits',
        // Jamais de cout/marge ici, ni nulle part ailleurs dans ce document -
        // seuls des prix de vente deja resolus entrent dans ce module.
      },
    });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('error', reject);

    const issues: CatalogueGenerationIssue[] = [];
    for (const p of data.products) {
      if (!p.imageBuffer) issues.push({ productId: p.id, productName: p.name, kind: 'missing_image' });
      if (p.cartonPriceHt == null) issues.push({ productId: p.id, productName: p.name, kind: 'missing_price' });
      else if (!p.unitsPerCarton) issues.push({ productId: p.id, productName: p.name, kind: 'missing_units' });
    }
    doc.on('end', () => resolve({ buffer: Buffer.concat(chunks), issues }));

    // Couverture commerciale - premiere page (creee automatiquement par
    // PDFDocument), sans en-tete ni grille.
    drawCatalogueCoverPage(doc, logoBuffer, pickCoverProducts(data.products));

    // Geometrie de fiche calculee UNE SEULE FOIS pour tout le document : la
    // grille est a hauteur de rangee fixe (priorite absolue "9 par page"),
    // donc ces hauteurs ne dependent d'aucun contenu particulier.
    // includeGap:true partout ici, pour la meme raison que dans fitToLines :
    // la valeur doit correspondre a la hauteur par ligne reellement utilisee
    // par PDFKit, jamais une estimation "sans interligne" trop courte.
    doc.fontSize(11).font('Helvetica');
    const nameBlockH = doc.currentLineHeight(true) * 2;
    doc.fontSize(25).font('Helvetica-Bold');
    const priceLineH = doc.currentLineHeight(true);
    const geom = { nameBlockH, priceLineH };

    doc.addPage();
    drawCatalogueHeader(doc, logoBuffer);

    // Grille stricte 3x3 = 9 par page, en continu (categories deja triees
    // par l'appelant, aucun saut de page ne doit etre provoque par un
    // changement de categorie - voir brief "priorite absolue 9 par page").
    data.products.forEach((p, i) => {
      const posInPage = i % 9;
      if (posInPage === 0 && i > 0) {
        doc.addPage();
        drawCatalogueHeader(doc, logoBuffer);
      }
      const col = posInPage % COLS;
      const row = Math.floor(posInPage / COLS);
      const x = CAT_LEFT + col * (COL_W + GUTTER);
      const rowY = CONTENT_TOP + row * ROW_H;

      drawCatalogueCard(doc, p, x, rowY, geom);

      const rowComplete = col === COLS - 1 || i === data.products.length - 1;
      if (rowComplete && row < 2) {
        const ly = CONTENT_TOP + (row + 1) * ROW_H - 12;
        doc.moveTo(CAT_LEFT, ly).lineTo(CAT_RIGHT, ly).lineWidth(0.5).strokeColor(CAT_BORDER).stroke();
      }
    });

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
