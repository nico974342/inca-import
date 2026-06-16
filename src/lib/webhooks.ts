const ORDER_WEBHOOK_URL  = import.meta.env.MAKE_WEBHOOK_ORDER_URL as string | undefined;
const CLIENT_WEBHOOK_URL = import.meta.env.MAKE_WEBHOOK_CLIENT_URL as string | undefined;

type OrderWebhookProduct = {
  name: string;
  qty: number;
  unit: string | null;
  price_ht: number;
  total_ht: number;
};

export type OrderWebhookPayload = {
  order_id: string;
  nom: string;
  societe: string | null;
  email: string | null;
  telephone: string | null;
  point_de_vente: string | null;
  products: OrderWebhookProduct[];
  total_ht: number;
  tva: number;
  total_ttc: number;
  date: string;
};

export type ClientWebhookPayload = {
  nom: string;
  societe: string | null;
  email: string | null;
  telephone: string | null;
  point_de_vente: string | null;
  adresse_livraison: string | null;
  date_inscription: string;
};

function postWebhook(url: string | undefined, payload: unknown): void {
  if (!url) return;
  // Fire-and-forget — never let Make.com being down block the caller.
  fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  }).catch(() => {});
}

export function sendOrderConfirmedWebhook(payload: OrderWebhookPayload): void {
  postWebhook(ORDER_WEBHOOK_URL, payload);
}

export function sendClientRegisteredWebhook(payload: ClientWebhookPayload): void {
  postWebhook(CLIENT_WEBHOOK_URL, payload);
}
