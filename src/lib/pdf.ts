import PDFDocument from 'pdfkit';

export interface PdfOrderItem {
  product_name: string;
  quantity: number;
  unit?: string | null;
  price_ht?: number | null;
}

export interface PdfOrderData {
  id: string;
  nom: string;
  societe?: string | null;
  email: string;
  telephone?: string | null;
  notes?: string | null;
  items: PdfOrderItem[];
  totalHT: number;
  date: string;
}

export interface DeliveryItem {
  product_name: string;
  quantity: number;
  unit?: string | null;
}

export interface DeliveryPDV {
  name: string;
  items: DeliveryItem[];
}

export interface PdfDeliveryData {
  id: string;
  date: string;
  transporter_email: string;
  pdvs: DeliveryPDV[];
  notes?: string | null;
}

const PRIMARY = '#C96334';
const INK     = '#1E1A16';
const MUTED   = '#706B65';
const SURFACE = '#F6F3EF';
const BORDER  = '#E7E2DC';
const WHITE   = '#FFFFFF';

export function generateOrderPDF(order: PdfOrderData): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 50, size: 'A4', info: { Title: `Commande ${order.id.slice(0, 8).toUpperCase()}`, Author: 'Inca Import' } });
    const chunks: Buffer[] = [];

    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    // ── Brand header ──────────────────────────────────
    doc.fontSize(22).font('Helvetica-Bold').fillColor(PRIMARY).text('Inca Import', 50, 50);
    doc.fontSize(9).font('Helvetica').fillColor(MUTED).text('Grossiste B2B · La Reunion, 974', 50, 78);

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
    const boxH = order.societe ? 88 : 75;
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

    let ry = tTop + 22;
    for (let i = 0; i < order.items.length; i++) {
      const item = order.items[i];
      const rowH = 24;
      doc.rect(50, ry, 495, rowH).fillColor(i % 2 === 0 ? WHITE : SURFACE).fill();
      doc.rect(50, ry, 495, rowH).lineWidth(0.3).strokeColor(BORDER).stroke();

      const lineHT = item.quantity * Number(item.price_ht ?? 0);
      const priceStr = item.price_ht != null ? `${lineHT.toFixed(2)} EUR` : '-';

      doc.fontSize(9).font('Helvetica').fillColor(INK)
        .text(item.product_name, cols.px, ry + 8, { width: 252, ellipsis: true })
        .text(item.unit ?? '-',  cols.ux, ry + 8)
        .text(String(item.quantity), cols.qx, ry + 8, { width: 45, align: 'right' })
        .text(priceStr, cols.hx, ry + 8, { width: 82, align: 'right' });

      ry += rowH;
    }

    // Total row
    ry += 8;
    doc.rect(350, ry, 195, 30).fillColor(SURFACE).fill();
    doc.rect(350, ry, 195, 30).lineWidth(0.5).strokeColor(BORDER).stroke();
    doc.fontSize(8).font('Helvetica-Bold').fillColor(MUTED)
      .text('TOTAL HT', 360, ry + 10);
    doc.fontSize(12).font('Helvetica-Bold').fillColor(INK)
      .text(`${order.totalHT.toFixed(2)} EUR`, cols.hx, ry + 9, { width: 82, align: 'right' });

    // Notes
    if (order.notes) {
      ry += 50;
      doc.fontSize(7).font('Helvetica-Bold').fillColor(MUTED).text('NOTES', 50, ry);
      doc.fontSize(9).font('Helvetica').fillColor(INK).text(order.notes, 50, ry + 14, { width: 495 });
    }

    // Footer
    doc.fontSize(7).font('Helvetica').fillColor(MUTED)
      .text('Inca Import · inca-import@hotmail.com · 0692 47 89 41 · La Reunion, 974', 50, 800, { width: 495, align: 'center' });

    doc.end();
  });
}

export function generateInvoicePDF(order: PdfOrderData): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 50, size: 'A4', info: { Title: `Facture ${order.id.slice(0, 8).toUpperCase()}`, Author: 'Inca Import' } });
    const chunks: Buffer[] = [];

    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const TVA_RATE = 0.085;
    const tva = order.totalHT * TVA_RATE;
    const ttc = order.totalHT + tva;

    // ── Brand header ──────────────────────────────────
    doc.fontSize(22).font('Helvetica-Bold').fillColor(PRIMARY).text('Inca Import', 50, 50);
    doc.fontSize(9).font('Helvetica').fillColor(MUTED)
      .text('Grossiste B2B · La Réunion', 50, 78)
      .text('29 Route des Premiers Français — 97400 Saint-Paul', 50, 93)
      .text('SIRET 945 112 753', 50, 108);

    // Document title + ref (top right)
    doc.fontSize(16).font('Helvetica-Bold').fillColor(INK)
      .text('FACTURE', 350, 50, { width: 195, align: 'right' });
    doc.fontSize(8).font('Helvetica').fillColor(MUTED)
      .text(`Réf. : ${order.id.slice(0, 8).toUpperCase()}`, 350, 74, { width: 195, align: 'right' })
      .text(`Date : ${order.date}`, 350, 88, { width: 195, align: 'right' });

    // Divider
    doc.moveTo(50, 128).lineTo(545, 128).lineWidth(0.5).strokeColor(BORDER).stroke();

    // ── Client info box ───────────────────────────────
    const boxTop = 148;
    const boxH = order.societe ? 88 : 75;
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
    doc.fontSize(9).font('Helvetica').fillColor(MUTED).text(order.email, 65, cy);
    if (order.telephone) {
      doc.fontSize(9).font('Helvetica').fillColor(MUTED).text(order.telephone, 220, cy);
    }

    // ── Products table ────────────────────────────────
    const tTop = boxTop + boxH + 20;
    const cols = { px: 58, ux: 318, qx: 393, hx: 453 };

    doc.rect(50, tTop, 495, 22).fillColor(PRIMARY).fill();
    doc.fontSize(8).font('Helvetica-Bold').fillColor(WHITE)
      .text('PRODUIT',  cols.px, tTop + 7)
      .text('UNITE',    cols.ux, tTop + 7)
      .text('QTE',      cols.qx, tTop + 7, { width: 45, align: 'right' })
      .text('TOTAL HT', cols.hx, tTop + 7, { width: 82, align: 'right' });

    let ry = tTop + 22;
    for (let i = 0; i < order.items.length; i++) {
      const item = order.items[i];
      const rowH = 24;
      doc.rect(50, ry, 495, rowH).fillColor(i % 2 === 0 ? WHITE : SURFACE).fill();
      doc.rect(50, ry, 495, rowH).lineWidth(0.3).strokeColor(BORDER).stroke();

      const lineHT = item.quantity * Number(item.price_ht ?? 0);
      const priceStr = item.price_ht != null ? `${lineHT.toFixed(2)} EUR` : '-';

      doc.fontSize(9).font('Helvetica').fillColor(INK)
        .text(item.product_name, cols.px, ry + 8, { width: 252, ellipsis: true })
        .text(item.unit ?? '-',  cols.ux, ry + 8)
        .text(String(item.quantity), cols.qx, ry + 8, { width: 45, align: 'right' })
        .text(priceStr, cols.hx, ry + 8, { width: 82, align: 'right' });

      ry += rowH;
    }

    // ── Totals block ──────────────────────────────────
    ry += 12;
    const totalsH = 76;
    doc.rect(350, ry, 195, totalsH).fillColor(SURFACE).fill();
    doc.rect(350, ry, 195, totalsH).lineWidth(0.5).strokeColor(BORDER).stroke();

    doc.fontSize(8).font('Helvetica').fillColor(MUTED)
      .text('Total HT', 360, ry + 12)
      .text(`${order.totalHT.toFixed(2)} EUR`, cols.hx, ry + 12, { width: 82, align: 'right' });

    doc.fontSize(8).font('Helvetica').fillColor(MUTED)
      .text('TVA 8,5 %', 360, ry + 30)
      .text(`${tva.toFixed(2)} EUR`, cols.hx, ry + 30, { width: 82, align: 'right' });

    doc.moveTo(360, ry + 46).lineTo(535, ry + 46).lineWidth(0.5).strokeColor(BORDER).stroke();

    doc.fontSize(9).font('Helvetica-Bold').fillColor(INK)
      .text('TOTAL TTC', 360, ry + 54)
      .text(`${ttc.toFixed(2)} EUR`, cols.hx, ry + 54, { width: 82, align: 'right' });

    // Notes
    if (order.notes) {
      ry += totalsH + 20;
      doc.fontSize(7).font('Helvetica-Bold').fillColor(MUTED).text('NOTES', 50, ry);
      doc.fontSize(9).font('Helvetica').fillColor(INK).text(order.notes, 50, ry + 14, { width: 495 });
    }

    // Footer
    doc.fontSize(7).font('Helvetica').fillColor(MUTED)
      .text('Inca Import · SIRET 945 112 753 · 29 Route des Premiers Français, 97400 Saint-Paul, La Réunion', 50, 790, { width: 495, align: 'center' })
      .text('inca-import@hotmail.com · 0692 47 89 41', 50, 802, { width: 495, align: 'center' });

    doc.end();
  });
}

// ── Shared PDF helpers ─────────────────────────────────────────────────────

function drawHeader(doc: InstanceType<typeof PDFDocument>, opts: {
  id: string; date: string; title: string; withAddress?: boolean;
}) {
  doc.fontSize(22).font('Helvetica-Bold').fillColor(PRIMARY).text('Inca Import', 50, 50);
  if (opts.withAddress) {
    doc.fontSize(9).font('Helvetica').fillColor(MUTED)
      .text('Grossiste B2B · La Réunion', 50, 78)
      .text('29 Route des Premiers Français — 97460 Saint-Paul', 50, 92)
      .text('SIRET 945 112 753', 50, 106);
    doc.moveTo(50, 124).lineTo(545, 124).lineWidth(0.5).strokeColor(BORDER).stroke();
  } else {
    doc.fontSize(9).font('Helvetica').fillColor(MUTED).text('Grossiste B2B · La Réunion, 974', 50, 78);
    doc.moveTo(50, 98).lineTo(545, 98).lineWidth(0.5).strokeColor(BORDER).stroke();
  }
  const rightTop = 50;
  doc.fontSize(8).font('Helvetica').fillColor(MUTED)
    .text(`Réf. : ${opts.id}`, 350, rightTop, { width: 195, align: 'right' })
    .text(`Date : ${opts.date}`, 350, rightTop + 13, { width: 195, align: 'right' });

  const titleY = opts.withAddress ? 140 : 114;
  doc.fontSize(14).font('Helvetica-Bold').fillColor(INK).text(opts.title, 50, titleY);
  return titleY + 30;
}

function drawProductTable(
  doc: InstanceType<typeof PDFDocument>,
  items: { product_name: string; quantity: number; unit?: string | null }[],
  startY: number,
): number {
  let y = startY;
  const cols = { px: 65, ux: 380, qx: 480 };

  doc.rect(50, y, 495, 20).fillColor(SURFACE).fill();
  doc.fontSize(7).font('Helvetica-Bold').fillColor(MUTED)
    .text('PRODUIT', cols.px, y + 6)
    .text('UNITÉ', cols.ux, y + 6)
    .text('QTÉ', cols.qx, y + 6, { width: 55, align: 'right' });
  y += 20;

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (y > 755) { doc.addPage(); y = 50; }
    doc.rect(50, y, 495, 22).fillColor(i % 2 === 0 ? WHITE : SURFACE).fill();
    doc.rect(50, y, 495, 22).lineWidth(0.3).strokeColor(BORDER).stroke();
    doc.fontSize(9).font('Helvetica').fillColor(INK)
      .text(item.product_name, cols.px, y + 7, { width: 305, ellipsis: true })
      .text(item.unit ?? '—', cols.ux, y + 7)
      .text(String(item.quantity), cols.qx, y + 7, { width: 55, align: 'right' });
    y += 22;
  }
  return y;
}

function drawTotalCartons(doc: InstanceType<typeof PDFDocument>, total: number, y: number): number {
  y += 6;
  doc.rect(350, y, 195, 28).fillColor(SURFACE).fill();
  doc.rect(350, y, 195, 28).lineWidth(0.5).strokeColor(BORDER).stroke();
  doc.fontSize(8).font('Helvetica').fillColor(MUTED).text('Total cartons', 362, y + 9);
  doc.fontSize(11).font('Helvetica-Bold').fillColor(INK)
    .text(String(total), 450, y + 8, { width: 85, align: 'right' });
  return y + 28;
}

function drawFooter(doc: InstanceType<typeof PDFDocument>) {
  doc.fontSize(7).font('Helvetica').fillColor(MUTED)
    .text(
      'Inca Import · SIRET 945 112 753 · 29 Route des Premiers Français, 97460 Saint-Paul, La Réunion · inca-import@hotmail.com · 0692 47 89 41',
      50, 800, { width: 495, align: 'center' }
    );
}

// ── Summary PDF: all PDVs + consolidated products ─────────────────────────

export function generateDeliverySummaryPDF(delivery: PdfDeliveryData): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 50, size: 'A4', info: { Title: `Récapitulatif ${delivery.id}`, Author: 'Inca Import' } });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    let y = drawHeader(doc, {
      id: delivery.id, date: delivery.date,
      title: 'RÉCAPITULATIF DE LIVRAISON',
      withAddress: true,
    });

    // ── Transporter box ───────────────────────────────
    y += 4;
    doc.rect(50, y, 495, 52).fillColor(SURFACE).fill();
    doc.rect(50, y, 495, 52).lineWidth(0.5).strokeColor(BORDER).stroke();
    doc.fontSize(7).font('Helvetica-Bold').fillColor(MUTED).text('TRANSPORTEUR', 65, y + 10);
    doc.fontSize(11).font('Helvetica-Bold').fillColor(INK).text('Coursier OI', 65, y + 23);
    doc.fontSize(9).font('Helvetica').fillColor(MUTED).text(delivery.transporter_email, 65, y + 38);
    y += 52 + 20;

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

    drawFooter(doc);
    doc.end();
  });
}

// ── Per-PDV PDF: one stop ─────────────────────────────────────────────────

export function generatePDVDeliveryPDF(
  pdv: DeliveryPDV, deliveryId: string, date: string
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 50, size: 'A4', info: { Title: `Livraison ${pdv.name} — ${deliveryId}`, Author: 'Inca Import' } });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    let y = drawHeader(doc, {
      id: deliveryId, date, title: 'BON DE LIVRAISON',
    });

    // PDV name as subtitle
    y -= 10;
    doc.fontSize(16).font('Helvetica-Bold').fillColor(PRIMARY)
      .text(pdv.name.toUpperCase(), 50, y, { width: 495 });
    y += doc.currentLineHeight() + 16;

    // Divider
    doc.moveTo(50, y).lineTo(545, y).lineWidth(0.5).strokeColor(BORDER).stroke();
    y += 16;

    const pdvTotal = pdv.items.reduce((s, i) => s + i.quantity, 0);

    // Product header bar
    doc.rect(50, y, 495, 26).fillColor(INK).fill();
    doc.fontSize(9).font('Helvetica-Bold').fillColor(WHITE)
      .text(`${pdv.items.length} article${pdv.items.length > 1 ? 's' : ''}`, 65, y + 8)
      .text(`${pdvTotal} carton${pdvTotal > 1 ? 's' : ''}`, 350, y + 8, { width: 180, align: 'right' });
    y += 26;

    y = drawProductTable(doc, pdv.items, y);
    y = drawTotalCartons(doc, pdvTotal, y);

    drawFooter(doc);
    doc.end();
  });
}
