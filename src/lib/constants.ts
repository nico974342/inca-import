// Single source of truth for values that were previously copy-pasted (and
// had drifted) across lib/email.ts, lib/pdf.ts, and several admin pages.

export const COMPANY = {
  name:         'Inca Import',
  addressLine:  '29 Route des Premiers Français',
  postalCode:   '97460',
  city:         'Saint-Paul',
  region:       'La Réunion',
  siret:        '945 112 753',
  phoneDisplay: '0692 47 89 41',
  phoneHref:    '+262692478941',
  contactEmail: 'inca-import@hotmail.com',
  siteUrl:      'https://www.inca-import.re',
} as const;

export const COMPANY_ADDRESS_LINE = `${COMPANY.addressLine}, ${COMPANY.postalCode} ${COMPANY.city}, ${COMPANY.region}`;

/** Fallback rate used only when a product/order line has no tva_rate snapshot. */
export const DEFAULT_TVA_RATE = 0.085;

/** Fixed monthly gross-margin break-even (point mort), in euros HT. Update
 *  here if the business's break-even point changes. */
export const MONTHLY_MARGIN_BREAKEVEN = 4700;

export const RESEND_DEFAULT_FROM = `${COMPANY.name} <noreply@inca-import.re>`;

// ── Order status ────────────────────────────────────────────────────────
export const ORDER_STATUSES = [
  'en_attente', 'confirmee', 'en_preparation', 'expediee', 'livree', 'annulee',
] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

export const ORDER_STATUS_LABEL: Record<OrderStatus, string> = {
  en_attente:     'En attente',
  confirmee:      'Confirmée',
  en_preparation: 'En préparation',
  expediee:       'Expédiée',
  livree:         'Livrée',
  annulee:        'Annulée',
};

export const ORDER_STATUS_COLOR: Record<OrderStatus, string> = {
  en_attente:     'muted',
  confirmee:      'blue',
  en_preparation: 'amber',
  expediee:       'purple',
  livree:         'green',
  annulee:        'red',
};

// ── Client account status (prospects live here too, as status='prospect') ──
export const CLIENT_STATUSES = ['prospect', 'en_attente', 'actif', 'suspendu'] as const;
export type ClientStatus = (typeof CLIENT_STATUSES)[number];

export const CLIENT_STATUS_LABEL: Record<ClientStatus, string> = {
  prospect:   'Prospect',
  en_attente: 'En attente',
  actif:      'Actif',
  suspendu:   'Suspendu',
};

export const CLIENT_STATUS_COLOR: Record<ClientStatus, string> = {
  prospect:   'purple',
  en_attente: 'amber',
  actif:      'green',
  suspendu:   'red',
};

// ── Client/prospect type ────────────────────────────────────────────────
export const CLIENT_TYPES = ['station_service', 'superette', 'autre'] as const;
export type ClientType = (typeof CLIENT_TYPES)[number];

export const CLIENT_TYPE_LABEL: Record<ClientType, string> = {
  station_service: 'Station-service',
  superette:       'Supérette',
  autre:           'Autre',
};

// ── Contact request status ─────────────────────────────────────────────
export const CONTACT_STATUSES = ['nouveau', 'contacte', 'converti', 'rejete'] as const;
export type ContactStatus = (typeof CONTACT_STATUSES)[number];

export const CONTACT_STATUS_LABEL: Record<ContactStatus, string> = {
  nouveau:  'Nouveau',
  contacte: 'Contacté',
  converti: 'Converti',
  rejete:   'Rejeté',
};

export const CONTACT_STATUS_COLOR: Record<ContactStatus, string> = {
  nouveau:  'blue',
  contacte: 'amber',
  converti: 'green',
  rejete:   'muted',
};

// ── Margin color thresholds (percent) ──────────────────────────────────
export function marginColorClass(pct: number | null): 'green' | 'amber' | 'red' | 'none' {
  if (pct == null) return 'none';
  if (pct >= 30) return 'green';
  if (pct >= 15) return 'amber';
  return 'red';
}

// ── GMROI (Gross Margin Return On Investment) ───────────────────────────
// GMROI = marge brute générée sur la période / valeur moyenne du stock
// immobilisé. Returns null (displayed as "—") when the ratio can't be
// meaningfully computed: no stock on hand, no PUMP recorded (can't value
// the stock), or no sales at all in the window (not enough data yet —
// deliberately distinct from a real "sold but broke even" zero).
export function computeGmroi(
  stockQuantity: number | null | undefined,
  pumpHt: number | null | undefined,
  marginOverPeriod: number | null | undefined,
): number | null {
  if (!stockQuantity || stockQuantity <= 0) return null;
  if (pumpHt == null || pumpHt <= 0) return null;
  if (marginOverPeriod == null) return null;
  return marginOverPeriod / (stockQuantity * pumpHt);
}

export function gmroiColorClass(value: number | null): 'green' | 'amber' | 'red' | 'none' {
  if (value == null) return 'none';
  if (value > 2) return 'green';
  if (value >= 1) return 'amber';
  return 'red';
}

// ── Taux de rotation des stocks (stock turnover rate) ───────────────────
// Rotation = coût des ventes générées sur la période / valeur moyenne du
// stock immobilisé. Same denominator and same null-handling rationale as
// GMROI (see above) — only the numerator differs (cost of goods sold,
// qty × PUMP, instead of gross margin).
export function computeStockRotation(
  stockQuantity: number | null | undefined,
  pumpHt: number | null | undefined,
  cogsOverPeriod: number | null | undefined,
): number | null {
  if (!stockQuantity || stockQuantity <= 0) return null;
  if (pumpHt == null || pumpHt <= 0) return null;
  if (cogsOverPeriod == null) return null;
  return cogsOverPeriod / (stockQuantity * pumpHt);
}

export function rotationColorClass(value: number | null): 'green' | 'amber' | 'red' | 'none' {
  if (value == null) return 'none';
  if (value > 6) return 'green';
  if (value >= 3) return 'amber';
  return 'red';
}
