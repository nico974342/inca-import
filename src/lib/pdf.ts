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

export function generateDeliveryPDF(delivery: PdfDeliveryData): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 50, size: 'A4', info: { Title: `Bon de Livraison ${delivery.id}`, Author: 'Inca Import' } });
    const chunks: Buffer[] = [];
    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    // ── Brand header ──────────────────────────────────
    doc.fontSize(22).font('Helvetica-Bold').fillColor(PRIMARY).text('Inca Import', 50, 50);
    doc.fontSize(9).font('Helvetica').fillColor(MUTED).text('Grossiste B2B · La Reunion, 974', 50, 78);
    doc.fontSize(8).font('Helvetica').fillColor(MUTED)
      .text(`Ref. : ${delivery.id}`, 350, 50, { width: 195, align: 'right' })
      .text(`Date : ${delivery.date}`, 350, 63, { width: 195, align: 'right' });
    doc.moveTo(50, 98).lineTo(545, 98).lineWidth(0.5).strokeColor(BORDER).stroke();

    // ── Document title ────────────────────────────────
    doc.fontSize(15).font('Helvetica-Bold').fillColor(INK).text('BON DE LIVRAISON', 50, 114);

    // ── Transporter box ───────────────────────────────
    const tbTop = 144;
    doc.rect(50, tbTop, 495, 52).fillColor(SURFACE).fill();
    doc.rect(50, tbTop, 495, 52).lineWidth(0.5).strokeColor(BORDER).stroke();
    doc.fontSize(7).font('Helvetica-Bold').fillColor(MUTED).text('TRANSPORTEUR', 65, tbTop + 10);
    doc.fontSize(11).font('Helvetica-Bold').fillColor(INK).text('Coursier OI', 65, tbTop + 23);
    doc.fontSize(9).font('Helvetica').fillColor(MUTED).text(delivery.transporter_email, 65, tbTop + 38);

    let y = tbTop + 52 + 20;

    // ── Per-PDV sections ──────────────────────────────
    for (const pdv of delivery.pdvs) {
      const estimatedH = 28 + 18 + pdv.items.length * 22 + 16;
      if (y + estimatedH > 750) { doc.addPage(); y = 50; }

      // PDV dark header
      doc.rect(50, y, 495, 28).fillColor(INK).fill();
      doc.fontSize(10).font('Helvetica-Bold').fillColor(WHITE)
        .text(pdv.name.toUpperCase(), 65, y + 9, { width: 420 });
      y += 28;

      // Column sub-header
      doc.rect(50, y, 495, 18).fillColor(SURFACE).fill();
      doc.fontSize(7).font('Helvetica-Bold').fillColor(MUTED)
        .text('PRODUIT', 65, y + 5)
        .text('UNITE', 390, y + 5)
        .text('QTE', 480, y + 5, { width: 55, align: 'right' });
      y += 18;

      for (let i = 0; i < pdv.items.length; i++) {
        const item = pdv.items[i];
        if (y > 760) { doc.addPage(); y = 50; }
        doc.rect(50, y, 495, 22).fillColor(i % 2 === 0 ? WHITE : SURFACE).fill();
        doc.rect(50, y, 495, 22).lineWidth(0.3).strokeColor(BORDER).stroke();
        doc.fontSize(9).font('Helvetica').fillColor(INK)
          .text(item.product_name, 65, y + 7, { width: 315, ellipsis: true })
          .text(item.unit ?? '-', 390, y + 7)
          .text(String(item.quantity), 480, y + 7, { width: 55, align: 'right' });
        y += 22;
      }

      y += 16;
    }

    // Notes
    if (delivery.notes) {
      if (y > 720) { doc.addPage(); y = 50; }
      doc.fontSize(7).font('Helvetica-Bold').fillColor(MUTED).text('NOTES', 50, y);
      doc.fontSize(9).font('Helvetica').fillColor(INK).text(delivery.notes, 50, y + 14, { width: 495 });
    }

    // Footer
    doc.fontSize(7).font('Helvetica').fillColor(MUTED)
      .text('Inca Import · inca-import@hotmail.com · 0692 47 89 41 · La Reunion, 974', 50, 800, { width: 495, align: 'center' });

    doc.end();
  });
}
