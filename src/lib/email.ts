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

const STATUS_MESSAGE: Record<string, string> = {
  en_attente:
    'Votre commande a bien été reçue. Notre équipe va la traiter dans les plus brefs délais et vous contactera si nécessaire.',
  confirmee:
    'Bonne nouvelle — votre commande est confirmée ! Elle va être préparée dans notre entrepôt à La Possession dès maintenant.',
  en_preparation:
    'Votre commande est en cours de préparation dans notre entrepôt. Nous vous tiendrons informé dès l\'expédition.',
  expediee:
    'C\'est parti ! Votre commande a été expédiée et sera livrée à votre point de vente dans les 48h.',
  livree:
    'Votre commande a bien été livrée. Merci de votre confiance. N\'hésitez pas à nous contacter pour votre prochain réassort.',
  annulee:
    'Votre commande a été annulée. Si vous avez des questions ou souhaitez repasser commande, contactez-nous par téléphone ou WhatsApp.',
};

type StatusStyle = { badgeBg: string; badgeColor: string; bannerBg: string; icon: string };

const STATUS_STYLE: Record<string, StatusStyle> = {
  en_attente:     { badgeBg: '#F3F4F6', badgeColor: '#4B5563', bannerBg: '#FAFAF9', icon: '⏳' },
  confirmee:      { badgeBg: '#DBEAFE', badgeColor: '#1D4ED8', bannerBg: '#EFF6FF', icon: '✅' },
  en_preparation: { badgeBg: '#FEF3C7', badgeColor: '#B45309', bannerBg: '#FFFBEB', icon: '📦' },
  expediee:       { badgeBg: '#EDE9FE', badgeColor: '#6D28D9', bannerBg: '#F5F3FF', icon: '🚚' },
  livree:         { badgeBg: '#DCFCE7', badgeColor: '#15803D', bannerBg: '#F0FDF4', icon: '🎉' },
  annulee:        { badgeBg: '#FEE2E2', badgeColor: '#B91C1C', bannerBg: '#FFF5F5', icon: '❌' },
};

export type OrderStatusEmailItem = { name: string; quantity: number; unit?: string | null };

export async function sendOrderStatusEmail(params: {
  to: string;
  orderId: string;
  status: string;
  items: OrderStatusEmailItem[];
  totalHt?: number | null;
}): Promise<void> {
  console.log('[email] sendOrderStatusEmail called', {
    to: params.to,
    orderId: params.orderId,
    status: params.status,
    itemCount: params.items.length,
    apiKeySet: !!API_KEY,
    from: FROM,
  });

  if (!API_KEY) {
    console.warn('[email] RESEND_API_KEY is not set — email not sent');
    return;
  }

  const { to, orderId, status, items, totalHt } = params;
  const label   = STATUS_LABEL[status] ?? status;
  const message = STATUS_MESSAGE[status] ?? '';
  const style   = STATUS_STYLE[status] ?? STATUS_STYLE['en_attente'];
  const shortId = orderId.slice(0, 8).toUpperCase();

  const itemRowsHtml = items.map(it => `
    <tr>
      <td style="padding:10px 16px;border-bottom:1px solid #F0EDE9;font-size:14px;color:#1C1917;line-height:1.4;">
        ${it.name}${it.unit ? `<br><span style="font-size:12px;color:#9CA3AF;">${it.unit}</span>` : ''}
      </td>
      <td style="padding:10px 16px;border-bottom:1px solid #F0EDE9;font-size:14px;color:#1C1917;text-align:center;white-space:nowrap;">
        ${it.quantity}
      </td>
    </tr>`).join('');

  const tableHtml = items.length > 0 ? `
    <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;border:1px solid #E8E4DF;border-radius:8px;overflow:hidden;margin-top:24px;">
      <thead>
        <tr style="background:#F5F4F2;">
          <th style="padding:10px 16px;font-size:11px;font-weight:700;color:#9CA3AF;text-align:left;text-transform:uppercase;letter-spacing:0.06em;">Produit</th>
          <th style="padding:10px 16px;font-size:11px;font-weight:700;color:#9CA3AF;text-align:center;text-transform:uppercase;letter-spacing:0.06em;">Qté</th>
        </tr>
      </thead>
      <tbody>${itemRowsHtml}</tbody>
      ${totalHt != null ? `
      <tfoot>
        <tr style="background:#F5F4F2;">
          <td style="padding:12px 16px;font-size:13px;font-weight:600;color:#6B7280;text-align:right;">Total HT</td>
          <td style="padding:12px 16px;font-size:15px;font-weight:700;color:#1C1917;text-align:center;white-space:nowrap;">${totalHt.toFixed(2).replace('.', ',')} €</td>
        </tr>
      </tfoot>` : ''}
    </table>` : '';

  const html = `<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <title>Commande #${shortId} — ${label}</title>
</head>
<body style="margin:0;padding:0;background:#F0EDE9;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;-webkit-font-smoothing:antialiased;">
  <table width="100%" cellpadding="0" cellspacing="0" role="presentation" style="background:#F0EDE9;padding:40px 20px;">
    <tr><td align="center">
      <table width="600" cellpadding="0" cellspacing="0" role="presentation" style="max-width:600px;width:100%;background:#FFFFFF;border-radius:12px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.08);">

        <!-- Header -->
        <tr>
          <td style="background:#E55A2B;padding:28px 40px;">
            <table width="100%" cellpadding="0" cellspacing="0" role="presentation">
              <tr>
                <td>
                  <span style="font-size:22px;font-weight:700;color:#FFFFFF;letter-spacing:-0.5px;line-height:1;">
                    Inca<span style="font-weight:400;"> Import</span>
                  </span>
                </td>
                <td align="right" valign="middle">
                  <span style="font-size:11px;color:rgba(255,255,255,0.72);font-weight:500;letter-spacing:0.02em;">
                    Grossiste B2B · La Réunion
                  </span>
                </td>
              </tr>
            </table>
          </td>
        </tr>

        <!-- Status banner -->
        <tr>
          <td style="background:${style.bannerBg};padding:16px 40px;border-bottom:1px solid #EAE6E1;">
            <table width="100%" cellpadding="0" cellspacing="0" role="presentation">
              <tr>
                <td valign="middle">
                  <span style="font-size:12px;font-weight:600;color:#9CA3AF;text-transform:uppercase;letter-spacing:0.07em;">
                    Statut de votre commande
                  </span>
                </td>
                <td align="right" valign="middle">
                  <span style="display:inline-block;background:${style.badgeBg};color:${style.badgeColor};font-size:13px;font-weight:700;padding:5px 14px;border-radius:99px;white-space:nowrap;">
                    ${style.icon}&nbsp; ${label}
                  </span>
                </td>
              </tr>
            </table>
          </td>
        </tr>

        <!-- Body -->
        <tr>
          <td style="padding:36px 40px 28px;">
            <!-- Order ref -->
            <p style="margin:0 0 6px;font-size:12px;font-weight:600;color:#C4BAB1;letter-spacing:0.08em;text-transform:uppercase;">
              Commande #${shortId}
            </p>
            <!-- Message -->
            <p style="margin:0 0 8px;font-size:18px;font-weight:700;color:#1C1917;letter-spacing:-0.3px;line-height:1.3;">
              ${label}
            </p>
            <p style="margin:0;font-size:15px;color:#57534E;line-height:1.65;">
              ${message}
            </p>

            <!-- Items table -->
            ${tableHtml}
          </td>
        </tr>

        <!-- Divider -->
        <tr><td style="padding:0 40px;"><div style="height:1px;background:#EAE6E1;"></div></td></tr>

        <!-- Footer -->
        <tr>
          <td style="padding:24px 40px 32px;background:#FAFAF9;">
            <p style="margin:0 0 12px;font-size:13px;font-weight:600;color:#1C1917;">
              Une question ? Contactez-nous :
            </p>
            <table cellpadding="0" cellspacing="0" role="presentation">
              <tr>
                <td style="padding-right:24px;">
                  <span style="font-size:13px;color:#57534E;">📞</span>&nbsp;
                  <a href="tel:+262692478941" style="font-size:13px;color:#E55A2B;text-decoration:none;font-weight:500;">0692 47 89 41</a>
                </td>
                <td>
                  <span style="font-size:13px;color:#57534E;">✉️</span>&nbsp;
                  <a href="mailto:inca-import@hotmail.com" style="font-size:13px;color:#E55A2B;text-decoration:none;font-weight:500;">inca-import@hotmail.com</a>
                </td>
              </tr>
            </table>
            <p style="margin:20px 0 0;font-size:11px;color:#C4BAB1;line-height:1.6;">
              Inca Import · 29 Route des Premiers Français · 97460 Saint-Paul, La Réunion<br>
              SIRET 945 112 753 · Disponible 7j/7
            </p>
          </td>
        </tr>

      </table>
    </td></tr>
  </table>
</body>
</html>`;

  const resend = new Resend(API_KEY);

  try {
    const result = await resend.emails.send({
      from: FROM,
      to: [to],
      subject: `${style.icon} Commande #${shortId} — ${label}`,
      html,
    });
    console.log('[email] sendOrderStatusEmail sent OK', result);
  } catch (err) {
    console.error('[email] sendOrderStatusEmail Resend error:', err);
    throw err;
  }
}

export async function sendLowStockAlert(productName: string, stock: number): Promise<void> {
  if (!API_KEY) {
    console.warn('[email] RESEND_API_KEY not set — low stock alert not sent');
    return;
  }

  const resend = new Resend(API_KEY);
  const label  = stock === 0 ? 'Rupture de stock' : `Stock bas : ${stock} restant${stock !== 1 ? 's' : ''}`;

  await resend.emails.send({
    from: FROM,
    to: [ADMIN],
    subject: `⚠️ ${label} — ${productName}`,
    html: `<!DOCTYPE html>
<html lang="fr">
<head><meta charset="UTF-8"/></head>
<body style="margin:0;padding:0;background:#F0EDE9;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#F0EDE9;padding:40px 20px;">
    <tr><td align="center">
      <table width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;background:#FFFFFF;border-radius:12px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.08);">
        <tr><td style="background:#E55A2B;padding:24px 36px;">
          <span style="font-size:20px;font-weight:700;color:#FFFFFF;">Inca<span style="font-weight:400;"> Import</span></span>
        </td></tr>
        <tr><td style="padding:32px 36px;">
          <p style="margin:0 0 12px;font-size:20px;font-weight:700;color:#1C1917;">⚠️ Alerte stock bas</p>
          <p style="margin:0 0 8px;font-size:15px;color:#57534E;">
            Le produit <strong style="color:#1C1917;">${productName}</strong> est passé à
            <strong style="color:${stock === 0 ? '#B91C1C' : '#B45309'};">${stock} carton${stock !== 1 ? 's' : ''}</strong> en stock.
          </p>
          ${stock === 0
            ? '<p style="margin:0;font-size:14px;font-weight:600;color:#B91C1C;">Rupture de stock — réapprovisionnement urgent.</p>'
            : '<p style="margin:0;font-size:14px;color:#57534E;">Pensez à réapprovisionner ce produit rapidement.</p>'}
        </td></tr>
        <tr><td style="padding:16px 36px 24px;background:#FAFAF9;border-top:1px solid #EAE6E1;">
          <p style="margin:0;font-size:11px;color:#C4BAB1;">Inca Import · Gestion des stocks</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`,
  });
}
