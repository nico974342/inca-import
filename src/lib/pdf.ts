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
}

export interface DeliveryPDV {
  name: string;
  items: DeliveryItem[];
  client_nom?: string | null;
  client_societe?: string | null;
  client_address?: string | null;
}

export interface PdfDeliveryData {
  id: string;
  date: string;
  pdvs: DeliveryPDV[];
  notes?: string | null;
}

const PRIMARY  = '#C96334';
const INK      = '#1E1A16';
const MUTED    = '#706B65';
const SURFACE  = '#F6F3EF';
const ROW_ALT  = '#F2EFE9';   // subtle alternating row tint
const BORDER   = '#E7E2DC';
const WHITE    = '#FFFFFF';

const FOOTER_L1 = 'Inca Import · 29 Route des Premiers Français · 97460 Saint-Paul · SIRET 945 112 753';
const FOOTER_L2 = 'contact@inca-import.re · 0692 47 89 41';

export function generateOrderPDF(order: PdfOrderData): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 50, size: 'A4', bufferPages: true, info: { Title: `Commande ${order.id.slice(0, 8).toUpperCase()}`, Author: 'Inca Import' } });
    const chunks: Buffer[] = [];

    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const TVA_RATE = 0.085;
    const tva = order.totalHT * TVA_RATE;
    const ttc = order.totalHT + tva;

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
      .text('TVA 8,5 %', 360, ry + 30)
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
        .text('Inca Import · inca-import@hotmail.com · 0692 47 89 41 · La Reunion, 974', 50, 775, { width: 495, align: 'center', lineBreak: false });
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
      .text('TVA 8,5 %', 360, ry + 30)
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
        .text('Inca Import · SIRET 945 112 753 · 29 Route des Premiers Français, 97400 Saint-Paul, La Réunion', 50, 760, { width: 495, align: 'center', lineBreak: false })
        .text('inca-import@hotmail.com · 0692 47 89 41', 50, 772, { width: 495, align: 'center', lineBreak: false });
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
      .text('29 Route des Premiers Français — 97460 Saint-Paul', 50, 90)
      .text('SIRET 945 112 753', 50, 103);
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

    const TVA_RATE = 0.085;
    const PAGE_BOTTOM = 730;

    // Column positions
    const col = { desc: 58, descW: 210, qty: 272, qtyW: 40, unit: 316, unitW: 50, pu: 368, puW: 72, tot: 442, totW: 95 };

    // ── Header ─────────────────────────────────────────────────────────────
    doc.fontSize(20).font('Helvetica-Bold').fillColor(PRIMARY)
      .text('BON DE LIVRAISON', 50, 50, { lineBreak: false });
    doc.fontSize(9).font('Helvetica-Bold').fillColor(INK)
      .text(blNumber, 350, 50, { width: 195, align: 'right', lineBreak: false });
    doc.fontSize(8).font('Helvetica').fillColor(MUTED)
      .text(`Date : ${date}`, 350, 65, { width: 195, align: 'right', lineBreak: false });

    doc.moveTo(50, 84).lineTo(545, 84).lineWidth(0.5).strokeColor(BORDER).stroke();

    // ── Two-column info block ──────────────────────────────────────────────
    const infoY = 94;
    const infoH = 90;
    const halfW = 237;
    const rightX = 50 + halfW + 8;
    const rightW = 495 - halfW - 8;

    // Fournisseur (left)
    doc.rect(50, infoY, halfW, infoH).fillColor(SURFACE).fill();
    doc.rect(50, infoY, halfW, infoH).lineWidth(0.5).strokeColor(BORDER).stroke();
    doc.fontSize(7).font('Helvetica-Bold').fillColor(MUTED)
      .text('FOURNISSEUR', 62, infoY + 10, { lineBreak: false });
    doc.fontSize(10).font('Helvetica-Bold').fillColor(INK)
      .text('Inca Import', 62, infoY + 22, { lineBreak: false });
    doc.fontSize(8).font('Helvetica').fillColor(MUTED)
      .text('29 Route des Premiers Français', 62, infoY + 37, { lineBreak: false })
      .text('97460 Saint-Paul, La Réunion', 62, infoY + 50, { lineBreak: false })
      .text('SIRET : 945 112 753', 62, infoY + 63, { lineBreak: false });

    // Destinataire (right)
    doc.rect(rightX, infoY, rightW, infoH).fillColor(SURFACE).fill();
    doc.rect(rightX, infoY, rightW, infoH).lineWidth(0.5).strokeColor(BORDER).stroke();
    doc.fontSize(7).font('Helvetica-Bold').fillColor(MUTED)
      .text('DESTINATAIRE', rightX + 12, infoY + 10, { lineBreak: false });
    doc.fontSize(10).font('Helvetica-Bold').fillColor(INK)
      .text(pdv.name, rightX + 12, infoY + 22, { width: rightW - 24, lineBreak: false });

    let destY = infoY + 37;
    if (pdv.client_societe) {
      doc.fontSize(8).font('Helvetica').fillColor(MUTED)
        .text(pdv.client_societe, rightX + 12, destY, { width: rightW - 24, lineBreak: false });
      destY += 13;
    }
    if (pdv.client_nom && pdv.client_nom !== pdv.name) {
      doc.fontSize(8).font('Helvetica').fillColor(MUTED)
        .text(pdv.client_nom, rightX + 12, destY, { width: rightW - 24, lineBreak: false });
      destY += 13;
    }
    if (pdv.client_address) {
      doc.fontSize(8).font('Helvetica').fillColor(MUTED)
        .text(pdv.client_address, rightX + 12, destY, { width: rightW - 24, lineBreak: false });
    }

    // ── Product table ──────────────────────────────────────────────────────
    let ry = infoY + infoH + 15;

    const drawBLHeader = (y: number) => {
      doc.rect(50, y, 495, 22).fillColor(PRIMARY).fill();
      doc.fontSize(7.5).font('Helvetica-Bold').fillColor(WHITE)
        .text('DÉSIGNATION', col.desc, y + 7, { width: col.descW, lineBreak: false })
        .text('QTÉ',         col.qty,  y + 7, { width: col.qtyW,  align: 'right', lineBreak: false })
        .text('UNITÉ',       col.unit, y + 7, { width: col.unitW, lineBreak: false })
        .text('P.U. HT',     col.pu,   y + 7, { width: col.puW,   align: 'right', lineBreak: false })
        .text('TOTAL HT',    col.tot,  y + 7, { width: col.totW,  align: 'right', lineBreak: false });
      return y + 22;
    };

    ry = drawBLHeader(ry);
    let rowColorIdx = 0;
    let totalHTSum = 0;
    let totalQty = 0;

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

      const lineHT = item.quantity * Number(item.price_ht ?? 0);
      if (item.price_ht != null) totalHTSum += lineHT;
      totalQty += item.quantity;

      doc.fontSize(8.5).font('Helvetica').fillColor(INK)
        .text(item.product_name, col.desc, ry + 6, { width: col.descW, lineBreak: false });
      if (item.sku) {
        doc.fontSize(7).font('Helvetica').fillColor(MUTED)
          .text(`Réf. ${item.sku}`, col.desc, ry + 6 + Math.ceil(nameH), { width: col.descW, lineBreak: false });
      }

      doc.fontSize(8.5).font('Helvetica').fillColor(INK)
        .text(String(item.quantity), col.qty,  ry + 6, { width: col.qtyW,  align: 'right', lineBreak: false })
        .text(item.unit ?? '—',     col.unit, ry + 6, { width: col.unitW, lineBreak: false });

      if (item.price_ht != null) {
        doc.fillColor(INK)
          .text(`${Number(item.price_ht).toFixed(2)} €`, col.pu,  ry + 6, { width: col.puW,  align: 'right', lineBreak: false })
          .text(`${lineHT.toFixed(2)} €`,                col.tot, ry + 6, { width: col.totW, align: 'right', lineBreak: false });
      } else {
        doc.fillColor(MUTED)
          .text('—', col.pu,  ry + 6, { width: col.puW,  align: 'right', lineBreak: false })
          .text('—', col.tot, ry + 6, { width: col.totW, align: 'right', lineBreak: false });
      }

      ry += rowH;
      rowColorIdx++;
    }

    // QTÉ total row
    if (ry + 22 > PAGE_BOTTOM) { doc.addPage(); ry = 50; }
    doc.rect(50, ry, 495, 22).fillColor(SURFACE).fill();
    doc.rect(50, ry, 495, 22).lineWidth(0.3).strokeColor(BORDER).stroke();
    doc.fontSize(8).font('Helvetica-Bold').fillColor(MUTED)
      .text('TOTAL QTÉ', col.desc, ry + 7, { width: col.descW, lineBreak: false })
      .text(String(totalQty), col.qty, ry + 7, { width: col.qtyW, align: 'right', lineBreak: false });
    ry += 22;

    // Totals block HT / TVA / TTC
    const tva = totalHTSum * TVA_RATE;
    const ttc = totalHTSum + tva;
    const totalsH = 76;

    if (ry + 12 + totalsH > PAGE_BOTTOM) { doc.addPage(); ry = 50; }
    ry += 12;

    doc.rect(350, ry, 187, totalsH).fillColor(SURFACE).fill();
    doc.rect(350, ry, 187, totalsH).lineWidth(0.5).strokeColor(BORDER).stroke();

    doc.fontSize(8).font('Helvetica').fillColor(MUTED)
      .text('Total HT', 362, ry + 12, { lineBreak: false })
      .text(`${totalHTSum.toFixed(2)} €`, col.tot, ry + 12, { width: col.totW, align: 'right', lineBreak: false });
    doc.fontSize(8).font('Helvetica').fillColor(MUTED)
      .text('TVA 8,5 %', 362, ry + 30, { lineBreak: false })
      .text(`${tva.toFixed(2)} €`, col.tot, ry + 30, { width: col.totW, align: 'right', lineBreak: false });

    doc.moveTo(362, ry + 46).lineTo(537, ry + 46).lineWidth(0.5).strokeColor(BORDER).stroke();

    doc.fontSize(9).font('Helvetica-Bold').fillColor(INK)
      .text('TOTAL TTC', 362, ry + 54, { lineBreak: false })
      .text(`${ttc.toFixed(2)} €`, col.tot, ry + 54, { width: col.totW, align: 'right', lineBreak: false });

    // Footer on every page
    const totalPages = doc.bufferedPageRange().count;
    for (let p = 0; p < totalPages; p++) {
      doc.switchToPage(p);
      if (totalPages > 1) {
        doc.fontSize(7).font('Helvetica').fillColor(MUTED)
          .text(`Page ${p + 1} / ${totalPages}`, 400, 755, { width: 145, align: 'right', lineBreak: false });
      }
      doc.fontSize(7).font('Helvetica').fillColor(MUTED)
        .text('Inca Import · SIRET 945 112 753 · 29 Route des Premiers Français, 97460 Saint-Paul, La Réunion', 50, 760, { width: 495, align: 'center', lineBreak: false })
        .text('inca-import@hotmail.com · 0692 47 89 41', 50, 772, { width: 495, align: 'center', lineBreak: false });
    }
    doc.flushPages();
    doc.end();
  });
}
