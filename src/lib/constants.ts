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

/** Editable until delivered — stock is only decremented on the livree
 *  transition, so line items can be changed freely before that point. */
export function isOrderEditable(status: string): boolean {
  const idx = ORDER_STATUSES.indexOf(status as OrderStatus);
  return idx !== -1 && idx < ORDER_STATUSES.indexOf('livree');
}

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

// ── Réassort (automated restocking) ─────────────────────────────────────
/** Rolling window used to estimate weekly sales velocity — 8-12 weeks
 *  smooths out week-to-week noise without going stale on trend shifts. */
export const REAPPRO_WEEKS_LOOKBACK = 10;

/** Below this many weeks of history the velocity rests on very little data
 *  and should be presented as less reliable. */
export const VITESSE_SHORT_HISTORY_WEEKS = 4;

/** Minimum divisor, in weeks. A product created two days ago would otherwise
 *  divide by ~0.3 and report a wildly overstated weekly pace. */
const VITESSE_MIN_HISTORY_WEEKS = 1;

/** How many weeks of history actually back the velocity: the lookback window,
 *  capped by the product's age so a recently listed product isn't averaged
 *  over weeks it did not exist, and floored so the divisor can't approach 0.
 *  Falls back to the full window when the creation date is unknown. */
export function effectiveHistoryWeeks(createdAt: string | Date | null | undefined): number {
  if (!createdAt) return REAPPRO_WEEKS_LOOKBACK;
  const createdMs = new Date(createdAt).getTime();
  if (!Number.isFinite(createdMs)) return REAPPRO_WEEKS_LOOKBACK;
  const ageWeeks = (Date.now() - createdMs) / (7 * 24 * 60 * 60 * 1000);
  return Math.min(REAPPRO_WEEKS_LOOKBACK, Math.max(VITESSE_MIN_HISTORY_WEEKS, ageWeeks));
}

/** Cartons/week, from total quantity sold (confirmed+ orders) over the
 *  lookback window. Dividing by the product's effective history rather than
 *  a flat 10 keeps a product listed three weeks ago from reading as though
 *  it sold nothing for the seven weeks before it existed.
 *
 *  Note this still assumes the product was sellable for its whole life — a
 *  long stockout inside the window still drags the figure down. */
export function computeVitesseVente(
  qtyOverWindow: number,
  createdAt: string | Date | null | undefined,
): number {
  return qtyOverWindow / effectiveHistoryWeeks(createdAt);
}

/** Estimated days of stock remaining at the current sales pace. Null when
 *  there's no sales velocity to extrapolate from (can't estimate a runway
 *  for a product that hasn't sold in the window — distinct from 0, which
 *  means it's already out). */
export function computeJoursAvantRupture(
  stockQuantity: number | null | undefined,
  vitesseVenteWeekly: number | null | undefined,
): number | null {
  if (stockQuantity == null) return null;
  if (stockQuantity <= 0) return 0;
  if (!vitesseVenteWeekly || vitesseVenteWeekly <= 0) return null;
  return stockQuantity / (vitesseVenteWeekly / 7);
}

/** Cartons to order so stock covers the supplier lead time at the current
 *  sales pace: (daily rate × lead time) − stock on hand. Null when there's
 *  no sales velocity to size an order from; 0 (not null) when the current
 *  stock already covers the lead time — a real answer, not missing data. */
export function computeSuggestedReorderQty(
  vitesseVenteWeekly: number | null | undefined,
  delaiLivraisonJours: number | null | undefined,
  stockQuantity: number | null | undefined,
): number | null {
  if (!vitesseVenteWeekly || vitesseVenteWeekly <= 0) return null;
  const delai = delaiLivraisonJours ?? 21;
  const dailyRate = vitesseVenteWeekly / 7;
  const suggested = Math.ceil(dailyRate * delai - (stockQuantity ?? 0));
  return suggested > 0 ? suggested : 0;
}

// ── Simulateur de commande fournisseur ──────────────────────────────────
/** Planning horizon for the supplier order simulator: 3 months of cover. */
export const COUVERTURE_DEFAULT_WEEKS = 13;

/** 13 weeks / 3 months — the single source both the default horizon and the
 *  1/2/3/6-month selector derive from, so they can never drift apart. */
export const COUVERTURE_WEEKS_PER_MONTH = COUVERTURE_DEFAULT_WEEKS / 3;

/** Horizons offered by the on-page selector, in months. */
export const COUVERTURE_HORIZON_MONTHS = [1, 2, 3, 6] as const;

export function couvertureHorizonWeeks(months: number): number {
  return months * COUVERTURE_WEEKS_PER_MONTH;
}

/** Weeks of cover the current stock represents at the current sales pace.
 *  Null when there's no velocity to divide by — a product that hasn't sold
 *  has no meaningful runway, which is distinct from a runway of zero. */
export function computeCouvertureWeeks(
  stockQuantity: number | null | undefined,
  vitesseVenteWeekly: number | null | undefined,
): number | null {
  if (!vitesseVenteWeekly || vitesseVenteWeekly <= 0) return null;
  return (stockQuantity ?? 0) / vitesseVenteWeekly;
}

/** Fallback transit time when neither the product nor its supplier defines
 *  one. Deliberately conservative: under-ordering on a 50-day container is
 *  far more costly than slightly over-ordering on a local supplier. */
export const DELAI_LIVRAISON_DEFAUT_JOURS = 30;

export type DelaiSource = 'produit' | 'fournisseur' | 'defaut';

export type DelaiResolu = {
  jours: number;
  source: DelaiSource;
  /** Supplier name when the delay came from the supplier, else null. */
  fournisseur: string | null;
};

/** Transit time for a product, most specific source first:
 *   1. the product's own override (a deliberate per-product exception)
 *   2. its supplier's delay, from the most recent reception
 *   3. DELAI_LIVRAISON_DEFAUT_JOURS
 *  The source travels with the number so the UI can flag lines still resting
 *  on the default, which are the ones needing a real delay entered. */
export function resolveDelaiLivraison(
  produitDelaiJours: number | null | undefined,
  fournisseurNom: string | null | undefined,
  fournisseurDelaiJours: number | null | undefined,
): DelaiResolu {
  if (produitDelaiJours != null && produitDelaiJours >= 0) {
    return { jours: produitDelaiJours, source: 'produit', fournisseur: null };
  }
  if (fournisseurDelaiJours != null && fournisseurDelaiJours >= 0) {
    return { jours: fournisseurDelaiJours, source: 'fournisseur', fournisseur: fournisseurNom ?? null };
  }
  return { jours: DELAI_LIVRAISON_DEFAUT_JOURS, source: 'defaut', fournisseur: null };
}

/** How an order is sized.
 *  - 'amorcage'  — first order or catching up: cover the transit AND the
 *                  horizon, since nothing is in the pipeline behind it.
 *  - 'reassort'  — steady state: reorder one transit's worth at each arrival,
 *                  so deliveries chain without a gap. Standard import practice.
 */
export type ModeCommande = 'amorcage' | 'reassort';

/** Cartons to order, rounded up and floored at 0. Null when there's no
 *  velocity to size an order from — the caller shows "pas d'historique" and
 *  suggests 0 rather than treating it as a real 0. */
export function computeOrderQty(
  vitesseVenteWeekly: number | null | undefined,
  delaiWeeks: number,
  horizonWeeks: number,
  stockQuantity: number | null | undefined,
  mode: ModeCommande,
): number | null {
  if (!vitesseVenteWeekly || vitesseVenteWeekly <= 0) return null;
  const weeksCovered = mode === 'amorcage' ? delaiWeeks + horizonWeeks : delaiWeeks;
  const qty = Math.ceil(vitesseVenteWeekly * weeksCovered - (stockQuantity ?? 0));
  return qty > 0 ? qty : 0;
}

/** Days of stock left, as a date. Null when there's no velocity to
 *  extrapolate — same reasoning as computeJoursAvantRupture. */
export function estimatedRuptureDate(
  stockQuantity: number | null | undefined,
  vitesseVenteWeekly: number | null | undefined,
  from: Date = new Date(),
): Date | null {
  const jours = computeJoursAvantRupture(stockQuantity, vitesseVenteWeekly);
  if (jours == null) return null;
  return new Date(from.getTime() + jours * 24 * 60 * 60 * 1000);
}

export function estimatedArrivalDate(delaiJours: number, from: Date = new Date()): Date {
  return new Date(from.getTime() + delaiJours * 24 * 60 * 60 * 1000);
}

/** Task 1's flag condition: stock at or below the reorder point. */
export function isAtOrBelowSeuil(
  stockQuantity: number | null | undefined,
  seuilReappro: number | null | undefined,
): boolean {
  if (seuilReappro == null) return false;
  return (stockQuantity ?? 0) <= seuilReappro;
}

/** Broader than isAtOrBelowSeuil — also true when stock is getting close
 *  (within 50% headroom above the threshold) or when the estimated runway
 *  is shorter than the supplier lead time, i.e. it would run out before a
 *  fresh order could even arrive. Used to decide when a reorder suggestion
 *  is worth showing, not just a bare "low stock" flag. */
export function isApproachingOrBelowSeuil(
  stockQuantity: number | null | undefined,
  seuilReappro: number | null | undefined,
  joursAvantRupture: number | null | undefined,
  delaiLivraisonJours: number | null | undefined,
): boolean {
  if (seuilReappro == null) return false;
  const stock = stockQuantity ?? 0;
  if (stock <= seuilReappro * 1.5) return true;
  if (joursAvantRupture != null && delaiLivraisonJours != null && joursAvantRupture <= delaiLivraisonJours) return true;
  return false;
}
