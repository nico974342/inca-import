import { Resend } from 'resend';

const API_KEY = import.meta.env.RESEND_API_KEY as string | undefined;
const FROM    = (import.meta.env.RESEND_FROM as string | undefined) ?? 'Inca Import <noreply@inca-import.re>';
const ADMIN   = 'inca-import@hotmail.com';

export async function sendLowStockAlert(productName: string, stock: number): Promise<void> {
  if (!API_KEY) return;

  const resend = new Resend(API_KEY);
  const label  = stock === 0 ? 'Rupture de stock' : `Stock bas : ${stock} restant${stock !== 1 ? 's' : ''}`;

  await resend.emails.send({
    from: FROM,
    to: [ADMIN],
    subject: `${label} — ${productName}`,
    html: `
      <div style="font-family:Helvetica,sans-serif;max-width:520px;color:#1E1A16">
        <h2 style="color:#C96334;margin-top:0">⚠️ Alerte stock bas</h2>
        <p>Le produit <strong>${productName}</strong> est passé à
          <strong>${stock} carton${stock !== 1 ? 's' : ''}</strong> en stock.</p>
        ${stock === 0
          ? '<p style="color:#dc2626;font-weight:600">Rupture de stock — réapprovisionnement urgent.</p>'
          : '<p>Pensez à réapprovisionner ce produit rapidement.</p>'}
        <hr style="border:none;border-top:1px solid #E7E2DC;margin:20px 0"/>
        <p style="color:#706B65;font-size:12px">Inca Import · Gestion des stocks</p>
      </div>
    `,
  });
}
