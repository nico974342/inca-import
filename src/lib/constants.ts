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

// ── Client account status ──────────────────────────────────────────────
export const CLIENT_STATUSES = ['en_attente', 'actif', 'suspendu'] as const;
export type ClientStatus = (typeof CLIENT_STATUSES)[number];

export const CLIENT_STATUS_LABEL: Record<ClientStatus, string> = {
  en_attente: 'En attente',
  actif:      'Actif',
  suspendu:   'Suspendu',
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
