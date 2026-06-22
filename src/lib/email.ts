import { Resend } from 'resend';

const API_KEY  = import.meta.env.RESEND_API_KEY as string | undefined;
const FROM     = (import.meta.env.RESEND_FROM as string | undefined) ?? 'Inca Import <noreply@inca-import.re>';
const ADMIN    = 'inca-import@hotmail.com';
const SITE_URL = 'https://www.inca-import.re';
const TVA_RATE = 0.085;

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
    'Bonne nouvelle — votre commande est confirmée ! Elle va être préparée dans notre entrepôt à La Possession dès maintenant.',
  en_preparation:
    "Votre commande est en cours de préparation dans notre entrepôt. Nous vous tiendrons informé dès l'expédition.",
  expediee:
    "C'est parti ! Votre commande a été expédiée et sera livrée à votre point de vente dans les 48h.",
  livree:
    "Votre commande a bien été livrée. Merci de votre confiance. N'hésitez pas à nous contacter pour votre prochain réassort.",
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

const MONTHS_FR = [
  'janvier','février','mars','avril','mai','juin',
  'juillet','août','septembre','octobre','novembre','décembre',
];

function frenchDate(raw: Date | string | null | undefined): string | null {
  if (!raw) return null;
  const d = typeof raw === 'string' ? new Date(raw) : raw;
  if (isNaN(d.getTime())) return null;
  const h = d.getHours().toString().padStart(2, '0');
  const m = d.getMinutes().toString().padStart(2, '0');
  return `${d.getDate()} ${MONTHS_FR[d.getMonth()]} ${d.getFullYear()} à ${h}h${m}`;
}

function fmt(n: number): string {
  return n.toFixed(2).replace('.', ',');
}

export type OrderStatusEmailItem = { name: string; quantity: number; unit?: string | null };

export async function sendOrderStatusEmail(params: {
  to: string;
  orderId: string;
  status: string;
  items: OrderStatusEmailItem[];
  totalHt?: number | null;
  orderDate?: Date | string | null;
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

  const { to, orderId, status, items, totalHt, orderDate } = params;
  const label   = STATUS_LABEL[status] ?? status;
  const message = STATUS_MESSAGE[status] ?? '';
  const style   = STATUS_STYLE[status] ?? STATUS_STYLE['en_attente'];
  const shortId = orderId.slice(0, 8).toUpperCase();
  const dateStr = frenchDate(orderDate);

  const tva = totalHt != null ? totalHt * TVA_RATE : null;
  const ttc = totalHt != null ? totalHt + totalHt * TVA_RATE : null;

  const itemRowsHtml = items.map(it => `
    <tr>
      <td style="padding:12px 18px;border-bottom:1px solid #F0EDE9;font-size:14px;color:#1C1917;line-height:1.45;">
        ${it.name}${it.unit ? `<br><span style="font-size:12px;color:#9CA3AF;margin-top:2px;display:block;">${it.unit}</span>` : ''}
      </td>
      <td style="padding:12px 18px;border-bottom:1px solid #F0EDE9;font-size:14px;color:#1C1917;text-align:center;white-space:nowrap;font-variant-numeric:tabular-nums;">
        ${it.quantity}
      </td>
    </tr>`).join('');

  const tfootHtml = totalHt != null ? `
    <tfoot>
      <tr>
        <td style="padding:12px 18px 5px;font-size:13px;color:#6B7280;text-align:right;border-top:2px solid #E8E4DF;">Total HT</td>
        <td style="padding:12px 18px 5px;font-size:13px;font-weight:600;color:#1C1917;text-align:center;border-top:2px solid #E8E4DF;white-space:nowrap;">${fmt(totalHt)}&nbsp;€</td>
      </tr>
      <tr>
        <td style="padding:3px 18px 10px;font-size:12px;color:#9CA3AF;text-align:right;">TVA&nbsp;8,5&nbsp;%</td>
        <td style="padding:3px 18px 10px;font-size:12px;color:#9CA3AF;text-align:center;white-space:nowrap;">+&nbsp;${fmt(tva!)}&nbsp;€</td>
      </tr>
      <tr style="background:#F7F6F4;">
        <td style="padding:12px 18px;font-size:14px;font-weight:700;color:#1C1917;text-align:right;border-top:1px solid #E8E4DF;">Total TTC</td>
        <td style="padding:12px 18px;font-size:17px;font-weight:700;color:#E55A2B;text-align:center;white-space:nowrap;border-top:1px solid #E8E4DF;">${fmt(ttc!)}&nbsp;€</td>
      </tr>
    </tfoot>` : '';

  const tableHtml = items.length > 0 ? `
    <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;border:1px solid #E8E4DF;border-radius:10px;overflow:hidden;">
      <thead>
        <tr style="background:#F5F4F2;">
          <th style="padding:10px 18px;font-size:11px;font-weight:700;color:#9CA3AF;text-align:left;text-transform:uppercase;letter-spacing:0.07em;">Produit</th>
          <th style="padding:10px 18px;font-size:11px;font-weight:700;color:#9CA3AF;text-align:center;text-transform:uppercase;letter-spacing:0.07em;">Qté</th>
        </tr>
      </thead>
      <tbody>${itemRowsHtml}</tbody>
      ${tfootHtml}
    </table>` : '';

  const html = `<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <title>Commande #${shortId} — ${label}</title>
</head>
<body style="margin:0;padding:0;background:#EDE9E4;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;-webkit-font-smoothing:antialiased;">
  <table width="100%" cellpadding="0" cellspacing="0" role="presentation" style="background:#EDE9E4;padding:48px 20px;">
    <tr><td align="center">
      <table width="600" cellpadding="0" cellspacing="0" role="presentation" style="max-width:600px;width:100%;background:#FFFFFF;border-radius:20px;overflow:hidden;box-shadow:0 4px 48px rgba(28,25,23,0.09),0 0 0 1px rgba(28,25,23,0.05);">

        <!-- Header -->
        <tr>
          <td style="background:#E55A2B;padding:22px 44px;">
            <table width="100%" cellpadding="0" cellspacing="0" role="presentation">
              <tr>
                <td valign="middle">
                  <span style="font-size:19px;font-weight:700;color:#FFFFFF;letter-spacing:-0.5px;line-height:1;">
                    Inca<span style="font-weight:300;opacity:0.85;"> Import</span>
                  </span>
                </td>
                <td align="right" valign="middle">
                  <span style="font-size:11px;color:rgba(255,255,255,0.6);font-weight:500;letter-spacing:0.05em;">
                    Grossiste B2B&nbsp;·&nbsp;La&nbsp;Réunion
                  </span>
                </td>
              </tr>
            </table>
          </td>
        </tr>

        <!-- Hero: status icon + label + ref + date -->
        <tr>
          <td style="background:${style.bannerBg};padding:44px 44px 36px;text-align:center;border-bottom:1px solid #EAE6E1;">
            <p style="margin:0 0 18px;font-size:52px;line-height:1;">${style.icon}</p>
            <p style="margin:0 0 8px;font-size:24px;font-weight:700;color:#1C1917;letter-spacing:-0.5px;line-height:1.2;">${label}</p>
            <p style="margin:0${dateStr ? ' 0 3px' : ''};font-size:13px;color:#9CA3AF;font-weight:500;">
              Commande&nbsp;#${shortId}
            </p>
            ${dateStr ? `<p style="margin:0;font-size:12px;color:#B9B0A8;">Passée le ${dateStr}</p>` : ''}
          </td>
        </tr>

        <!-- Message -->
        <tr>
          <td style="padding:32px 48px 28px;">
            <p style="margin:0;font-size:15px;color:#57534E;line-height:1.75;text-align:center;">
              ${message}
            </p>
          </td>
        </tr>

        ${items.length > 0 ? `
        <!-- Items table -->
        <tr>
          <td style="padding:0 44px 36px;">
            ${tableHtml}
          </td>
        </tr>` : ''}

        <!-- CTA -->
        <tr>
          <td style="padding:0 44px 48px;text-align:center;">
            <a href="${SITE_URL}/mes-commandes"
               style="display:inline-block;background:#E55A2B;color:#FFFFFF;font-size:14px;font-weight:600;text-decoration:none;padding:14px 32px;border-radius:10px;letter-spacing:0.01em;line-height:1;">
              Voir ma commande &rarr;
            </a>
          </td>
        </tr>

        <!-- Divider -->
        <tr><td style="padding:0 44px;"><div style="height:1px;background:#EAE6E1;"></div></td></tr>

        <!-- Footer -->
        <tr>
          <td style="padding:28px 44px 36px;background:#FAFAF9;">
            <p style="margin:0 0 14px;font-size:13px;font-weight:600;color:#1C1917;">
              Une question&nbsp;? Contactez-nous&nbsp;:
            </p>
            <table cellpadding="0" cellspacing="0" role="presentation">
              <tr>
                <td style="padding-right:28px;padding-bottom:4px;">
                  <span style="font-size:13px;color:#78716C;">📞</span>&nbsp;
                  <a href="tel:+262692478941" style="font-size:13px;color:#E55A2B;text-decoration:none;font-weight:500;">0692&nbsp;47&nbsp;89&nbsp;41</a>
                </td>
                <td style="padding-bottom:4px;">
                  <span style="font-size:13px;color:#78716C;">✉️</span>&nbsp;
                  <a href="mailto:inca-import@hotmail.com" style="font-size:13px;color:#E55A2B;text-decoration:none;font-weight:500;">inca-import@hotmail.com</a>
                </td>
              </tr>
            </table>
            <p style="margin:18px 0 0;font-size:11px;color:#C4BAB1;line-height:1.8;">
              Inca Import · 29 Route des Premiers Français · 97460 Saint-Paul, La Réunion<br>
              SIRET&nbsp;945&nbsp;112&nbsp;753 · Disponible 7j/7
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

export async function sendClientActivationEmail(params: {
  to: string;
  nom: string;
}): Promise<void> {
  if (!API_KEY) {
    console.warn('[email] RESEND_API_KEY not set — client activation email not sent');
    return;
  }
  const { to, nom } = params;
  const firstName = nom.split(' ')[0] || nom;
  const resend = new Resend(API_KEY);

  const html = `<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <title>Votre compte Inca Import est activé</title>
</head>
<body style="margin:0;padding:0;background:#EDE9E4;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;-webkit-font-smoothing:antialiased;">
  <table width="100%" cellpadding="0" cellspacing="0" role="presentation" style="background:#EDE9E4;padding:48px 20px;">
    <tr><td align="center">
      <table width="560" cellpadding="0" cellspacing="0" role="presentation" style="max-width:560px;width:100%;background:#FFFFFF;border-radius:20px;overflow:hidden;box-shadow:0 4px 48px rgba(28,25,23,0.09),0 0 0 1px rgba(28,25,23,0.05);">
        <tr>
          <td style="background:#E55A2B;padding:22px 44px;">
            <table width="100%" cellpadding="0" cellspacing="0" role="presentation">
              <tr>
                <td><span style="font-size:19px;font-weight:700;color:#FFFFFF;letter-spacing:-0.5px;line-height:1;">Inca<span style="font-weight:300;opacity:0.85;"> Import</span></span></td>
                <td align="right"><span style="font-size:11px;color:rgba(255,255,255,0.6);font-weight:500;letter-spacing:0.05em;">Grossiste B2B&nbsp;·&nbsp;La&nbsp;Réunion</span></td>
              </tr>
            </table>
          </td>
        </tr>
        <tr>
          <td style="background:#F0FDF4;padding:44px 44px 36px;text-align:center;border-bottom:1px solid #EAE6E1;">
            <p style="margin:0 0 18px;font-size:52px;line-height:1;">✅</p>
            <p style="margin:0 0 8px;font-size:24px;font-weight:700;color:#1C1917;letter-spacing:-0.5px;line-height:1.2;">Compte activé !</p>
            <p style="margin:0;font-size:14px;color:#9CA3AF;font-weight:500;">Bienvenue chez Inca Import, ${firstName}</p>
          </td>
        </tr>
        <tr>
          <td style="padding:32px 48px 28px;">
            <p style="margin:0 0 16px;font-size:15px;color:#57534E;line-height:1.75;">Bonjour <strong style="color:#1C1917;">${nom}</strong>,</p>
            <p style="margin:0 0 16px;font-size:15px;color:#57534E;line-height:1.75;">
              Votre compte client Inca Import vient d'être activé par notre équipe. Vous pouvez désormais consulter nos tarifs professionnels et passer commande directement en ligne.
            </p>
            <p style="margin:0;font-size:15px;color:#57534E;line-height:1.75;">Livraison sous 48h partout à La Réunion.</p>
          </td>
        </tr>
        <tr>
          <td style="padding:0 44px 48px;text-align:center;">
            <a href="${SITE_URL}/catalogue" style="display:inline-block;background:#E55A2B;color:#FFFFFF;font-size:14px;font-weight:600;text-decoration:none;padding:14px 32px;border-radius:10px;letter-spacing:0.01em;line-height:1;">
              Consulter le catalogue &rarr;
            </a>
          </td>
        </tr>
        <tr><td style="padding:0 44px;"><div style="height:1px;background:#EAE6E1;"></div></td></tr>
        <tr>
          <td style="padding:28px 44px 36px;background:#FAFAF9;">
            <p style="margin:0 0 14px;font-size:13px;font-weight:600;color:#1C1917;">Une question ? Contactez-nous :</p>
            <table cellpadding="0" cellspacing="0" role="presentation">
              <tr>
                <td style="padding-right:28px;padding-bottom:4px;">
                  <span style="font-size:13px;color:#78716C;">📞</span>&nbsp;
                  <a href="tel:+262692478941" style="font-size:13px;color:#E55A2B;text-decoration:none;font-weight:500;">0692&nbsp;47&nbsp;89&nbsp;41</a>
                </td>
                <td style="padding-bottom:4px;">
                  <span style="font-size:13px;color:#78716C;">✉️</span>&nbsp;
                  <a href="mailto:inca-import@hotmail.com" style="font-size:13px;color:#E55A2B;text-decoration:none;font-weight:500;">inca-import@hotmail.com</a>
                </td>
              </tr>
            </table>
            <p style="margin:18px 0 0;font-size:11px;color:#C4BAB1;line-height:1.8;">
              Inca Import · 29 Route des Premiers Français · 97460 Saint-Paul, La Réunion<br>
              SIRET&nbsp;945&nbsp;112&nbsp;753 · Disponible 7j/7
            </p>
          </td>
        </tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;

  try {
    await resend.emails.send({
      from: FROM,
      to: [to],
      subject: '✅ Votre compte Inca Import est activé — consultez nos tarifs',
      html,
    });
    console.log('[email] sendClientActivationEmail sent OK to', to);
  } catch (err) {
    console.error('[email] sendClientActivationEmail error:', err);
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
<body style="margin:0;padding:0;background:#EDE9E4;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#EDE9E4;padding:48px 20px;">
    <tr><td align="center">
      <table width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;background:#FFFFFF;border-radius:20px;overflow:hidden;box-shadow:0 4px 48px rgba(28,25,23,0.09),0 0 0 1px rgba(28,25,23,0.05);">
        <tr><td style="background:#E55A2B;padding:22px 44px;">
          <span style="font-size:19px;font-weight:700;color:#FFFFFF;letter-spacing:-0.5px;">Inca<span style="font-weight:300;opacity:0.85;"> Import</span></span>
        </td></tr>
        <tr><td style="padding:36px 44px 28px;">
          <p style="margin:0 0 16px;font-size:22px;font-weight:700;color:#1C1917;">⚠️ Alerte stock bas</p>
          <p style="margin:0 0 10px;font-size:15px;color:#57534E;line-height:1.7;">
            Le produit <strong style="color:#1C1917;">${productName}</strong> est passé à
            <strong style="color:${stock === 0 ? '#B91C1C' : '#B45309'};">${stock} carton${stock !== 1 ? 's' : ''}</strong> en stock.
          </p>
          ${stock === 0
            ? '<p style="margin:0;font-size:14px;font-weight:600;color:#B91C1C;">Rupture de stock — réapprovisionnement urgent.</p>'
            : '<p style="margin:0;font-size:14px;color:#57534E;">Pensez à réapprovisionner ce produit rapidement.</p>'}
        </td></tr>
        <tr><td style="padding:0 44px;"><div style="height:1px;background:#EAE6E1;"></div></td></tr>
        <tr><td style="padding:20px 44px 28px;background:#FAFAF9;">
          <p style="margin:0;font-size:11px;color:#C4BAB1;line-height:1.8;">Inca Import · Gestion des stocks</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`,
  });
}
