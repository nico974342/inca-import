import { Resend } from 'resend';

const API_KEY = import.meta.env.RESEND_API_KEY as string | undefined;
const FROM    = (import.meta.env.RESEND_FROM as string | undefined) ?? 'Inca Import <noreply@inca-import.re>';
const ADMIN   = 'inca-import@hotmail.com';

const STATUS_LABEL: Record<string, string> = {
  en_attente:     'En attente',
  confirmee:      'Confirmée',
  en_preparation: 'En préparation',
  expediee:       'Expédiée',
  livree:         'Livrée',
  annulee:        'Annulée',
};

const STATUS_NEXT_STEPS: Record<string, string> = {
  en_attente:     'Votre commande a bien été reçue et est en attente de traitement par notre équipe.',
  confirmee:      'Votre commande est confirmée. Elle va être préparée prochainement.',
  en_preparation: 'Votre commande est en cours de préparation dans notre entrepôt.',
  expediee:       'Votre commande a été expédiée. Elle arrive bientôt !',
  livree:         'Votre commande a été livrée. Merci de votre confiance !',
  annulee:        'Votre commande a été annulée. Contactez-nous si vous avez des questions.',
};

export type OrderStatusEmailItem = { name: string; quantity: number; unit?: string | null };

export async function sendOrderStatusEmail(params: {
  to: string;
  orderId: string;
  status: string;
  items: OrderStatusEmailItem[];
  totalHt?: number | null;
}): Promise<void> {
  if (!API_KEY) return;

  const { to, orderId, status, items, totalHt } = params;
  const label     = STATUS_LABEL[status] ?? status;
  const nextSteps = STATUS_NEXT_STEPS[status] ?? '';
  const shortId   = orderId.slice(0, 8).toUpperCase();

  const itemsHtml = items
    .map(it => `<li>${it.quantity} × ${it.name}${it.unit ? ` (${it.unit})` : ''}</li>`)
    .join('');

  const resend = new Resend(API_KEY);

  try {
    await resend.emails.send({
      from: 'onboarding@resend.dev',
      to: [to],
      subject: `Commande #${shortId} — ${label}`,
      html: `
        <div style="font-family:Helvetica,sans-serif;max-width:520px;color:#1E1A16">
          <h2 style="color:#C96334;margin-top:0">Commande #${shortId}</h2>
          <p>Nouveau statut : <strong>${label}</strong></p>
          <p>${nextSteps}</p>
          ${itemsHtml ? `<ul style="padding-left:20px">${itemsHtml}</ul>` : ''}
          ${totalHt != null ? `<p>Total HT : <strong>${totalHt.toFixed(2)} €</strong></p>` : ''}
          <hr style="border:none;border-top:1px solid #E7E2DC;margin:20px 0"/>
          <p style="color:#706B65;font-size:12px">Inca Import · Suivi de commande</p>
        </div>
      `,
    });
  } catch (err) {
    console.error('sendOrderStatusEmail failed:', err);
  }
}

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
