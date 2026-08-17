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
 *  capped by how long the product has actually been sellable, and floored so
 *  the divisor can't approach 0. Falls back to the full window when that date
 *  is unknown.
 *
 *  The caller resolves what "sellable since" means — usually
 *  max(products.created_at, date of the product's first reception), since a
 *  product listed in the catalogue on day 1 but only physically received on
 *  day 30 could not have sold anything in between. Passing created_at alone
 *  is still valid; it just means "assume sellable from creation," which is
 *  the best available answer when no reception exists yet. */
export function effectiveHistoryWeeks(sellableSince: string | Date | null | undefined): number {
  if (!sellableSince) return REAPPRO_WEEKS_LOOKBACK;
  const sinceMs = new Date(sellableSince).getTime();
  if (!Number.isFinite(sinceMs)) return REAPPRO_WEEKS_LOOKBACK;
  const ageWeeks = (Date.now() - sinceMs) / (7 * 24 * 60 * 60 * 1000);
  return Math.min(REAPPRO_WEEKS_LOOKBACK, Math.max(VITESSE_MIN_HISTORY_WEEKS, ageWeeks));
}

/** Cartons/week, from total quantity sold (confirmed+ orders) over the
 *  lookback window. Dividing by the product's effective history rather than
 *  a flat 10 keeps a product listed three weeks ago from reading as though
 *  it sold nothing for the seven weeks before it existed.
 *
 *  Note this still assumes the product was sellable for its whole
 *  effective-history span — a stockout inside that span still drags the
 *  figure down; see effectiveHistoryWeeks for the "sellable since" caveat. */
export function computeVitesseVente(
  qtyOverWindow: number,
  sellableSince: string | Date | null | undefined,
): number {
  return qtyOverWindow / effectiveHistoryWeeks(sellableSince);
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

export type CycleSource = 'fournisseur' | 'delai';

export type CycleResolu = {
  jours: number;
  source: CycleSource;
};

/** Order-cycle length for a product's supplier, most specific source first:
 *   1. the supplier's own cycle_commande_jours (how often *this* supplier is
 *      actually reordered — set on /admin/fournisseurs)
 *   2. the supplier's delivery delay (the assumption "I reorder at each
 *      arrival" — a reasonable default until the real cadence is known)
 *   3. the delay already resolved for this product (resolveDelaiLivraison's
 *      result), when the supplier itself has neither value set.
 *  Deliberately NOT a single page-wide value: two suppliers with different
 *  reorder rhythms must not share one cycle, or the réassort formula's
 *  chaining logic silently misrepresents whichever supplier didn't set the
 *  page-wide number. */
export function resolveCycleCommande(
  fournisseurCycleJours: number | null | undefined,
  fournisseurDelaiJours: number | null | undefined,
  delaiResoluJours: number,
): CycleResolu {
  // > 0 ici (pas >= 0) : un cycle de commande de 0 jour n'a pas de sens,
  // contrairement au délai qui peut légitimement être 0 (fournisseur local
  // livré le jour même) — cohérent avec la contrainte CHECK en base sur
  // cycle_commande_jours. Le repli sur le délai, lui, hérite du délai tel
  // quel : un délai à 0 j reste une valeur valide pour ce repli.
  if (fournisseurCycleJours != null && fournisseurCycleJours > 0) {
    return { jours: fournisseurCycleJours, source: 'fournisseur' };
  }
  if (fournisseurDelaiJours != null && fournisseurDelaiJours >= 0) {
    return { jours: fournisseurDelaiJours, source: 'delai' };
  }
  return { jours: delaiResoluJours, source: 'delai' };
}

/** How an order is sized.
 *  - 'amorcage'  — first order or catching up: cover the transit AND the
 *                  horizon, since nothing is in the pipeline behind it.
 *  - 'reassort'  — steady state: reorder one order-cycle's worth at each
 *                  arrival, so deliveries chain without a gap. Standard
 *                  import practice — see computeWeeksCovered for why this
 *                  needs the cycle length, not just the transit delay.
 */
export type ModeCommande = 'amorcage' | 'reassort';

/** The span of time (in weeks) an order needs to cover, before the security
 *  margin and stock on hand are factored in.
 *
 *  Amorçage: délai + horizon. First order, or catching up — nothing is
 *  already in the pipeline, so the order must bridge the transit AND the
 *  whole planning horizon on its own.
 *
 *  Réassort: délai + cycle_de_commande, NOT délai alone. A réassort order
 *  sized on the transit delay by itself only replaces what a single
 *  shipment will sell THROUGH — by the time that shipment lands, nothing is
 *  behind it, and stock runs out again the moment it depletes. Adding the
 *  reorder cycle (how often orders actually get placed with this supplier)
 *  means each order also covers the gap until the NEXT order's shipment
 *  arrives, so shipments chain without a hole between them. */
export function computeWeeksCovered(
  mode: ModeCommande,
  delaiWeeks: number,
  horizonWeeks: number,
  cycleWeeks: number,
): number {
  return mode === 'amorcage' ? delaiWeeks + horizonWeeks : delaiWeeks + cycleWeeks;
}

/** Security-stock buffer, in cartons, added on top of the base need.
 *  Computed from the ADJUSTED velocity (post seasonal-coefficient), same as
 *  the rest of the order-sizing math — a safety margin sized on last
 *  season's pace would defeat its own purpose during a spike. 0 when there's
 *  no velocity or no days configured, never negative. */
export function computeSecuriteCartons(
  vitesseAdjustedWeekly: number | null | undefined,
  joursSecurite: number | null | undefined,
): number {
  if (!vitesseAdjustedWeekly || vitesseAdjustedWeekly <= 0) return 0;
  return vitesseAdjustedWeekly * ((joursSecurite ?? 0) / 7);
}

/** Cartons to order, rounded up and floored at 0. Null when there's no
 *  velocity to size an order from — the caller shows "pas d'historique" and
 *  suggests 0 rather than treating it as a real 0.
 *
 *  vitesseAdjustedWeekly is the velocity AFTER the seasonal coefficient has
 *  been applied (V × coef/100) — this function has no opinion on seasonality,
 *  it just multiplies whatever pace it's given. weeksCovered comes from
 *  computeWeeksCovered; securiteCartons from computeSecuriteCartons.
 *  stockQuantity is the available stock (physical − reserved), not physical
 *  alone — cartons already promised to a client can't absorb future demand. */
export function computeOrderQty(
  vitesseAdjustedWeekly: number | null | undefined,
  weeksCovered: number,
  securiteCartons: number,
  stockQuantity: number | null | undefined,
): number | null {
  if (!vitesseAdjustedWeekly || vitesseAdjustedWeekly <= 0) return null;
  const qty = Math.ceil(vitesseAdjustedWeekly * weeksCovered + securiteCartons - (stockQuantity ?? 0));
  return qty > 0 ? qty : 0;
}

export function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 24 * 60 * 60 * 1000);
}

/** Days of stock left, as a date. Null when there's no velocity to
 *  extrapolate — same reasoning as computeJoursAvantRupture.
 *
 *  Pass the ADJUSTED velocity (post seasonal-coefficient): this date feeds
 *  the "rupture before arrival" alert, which is exactly the forward-looking
 *  decision the coefficient exists to inform — a rupture date computed on
 *  last season's pace during a spike would silently mislead. */
export function estimatedRuptureDate(
  stockQuantity: number | null | undefined,
  vitesseAdjustedWeekly: number | null | undefined,
  from: Date = new Date(),
): Date | null {
  const jours = computeJoursAvantRupture(stockQuantity, vitesseAdjustedWeekly);
  if (jours == null) return null;
  return addDays(from, jours);
}

export function estimatedArrivalDate(delaiJours: number, from: Date = new Date()): Date {
  return addDays(from, delaiJours);
}

/** The arrival date shifted by the security margin, for the "rupture before
 *  arrival" comparison: an order landing exactly the day stock hits zero is
 *  already a dangerous outcome, not a narrowly-avoided one, so the margin
 *  pushes the comparison point earlier rather than only sizing the order
 *  quantity. */
export function estimatedArrivalWithMargin(
  delaiJours: number,
  joursSecurite: number | null | undefined,
  from: Date = new Date(),
): Date {
  return addDays(estimatedArrivalDate(delaiJours, from), joursSecurite ?? 0);
}

// ── Suivi des expéditions (transit) ─────────────────────────────────────
export const SHIPMENT_STATUSES = ['commande', 'en_transit', 'arrive_port', 'dedouanement', 'receptionne'] as const;
export type ShipmentStatus = (typeof SHIPMENT_STATUSES)[number];

export const SHIPMENT_STATUS_LABEL: Record<ShipmentStatus, string> = {
  commande:     'Commandé',
  en_transit:   'En transit',
  arrive_port:  'Arrivé au port',
  dedouanement: 'Dédouanement',
  receptionne:  'Réceptionné',
};

/** Statuses that still count as "on the water" — the active list, and the
 *  quantities the order simulator reports as already under way. */
export const SHIPMENT_ACTIVE_STATUSES = ['commande', 'en_transit', 'arrive_port', 'dedouanement'] as const;

/** Late only while the goods are still genuinely en route: once a shipment
 *  is at the port or in customs, a passed ETA is expected, not a delay. */
const SHIPMENT_LATE_STATUSES: readonly string[] = ['commande', 'en_transit'];

/** Physically arrived, whatever the ETA said. The status is the truth here:
 *  a shipment can reach the port a week early. */
const SHIPMENT_ARRIVED_STATUSES: readonly string[] = ['arrive_port', 'dedouanement'];

// ── Cargo embarqué ──────────────────────────────────────────────────────
/**
 * Couleurs des conteneurs, une par famille de produits. Plus saturées que les
 * badges catégorie, qui sont des fonds de pastille : ici ce sont des blocs de
 * 6 px qui doivent se distinguer à taille réelle.
 *
 * Les clartés sont volontairement étagées (0.46 → 0.70) en plus des teintes :
 * la couleur portant ici une donnée, deux catégories ne doivent pas se
 * distinguer par la seule teinte — bleu 220 et teal 180 à clarté égale
 * devenaient indiscernables une fois réduits.
 */
export const CATEGORY_CARGO_COLOR: Record<string, string> = {
  divers:      'oklch(0.46 0.110 285)',
  boissons:    'oklch(0.52 0.130 235)',
  confiseries: 'oklch(0.58 0.140 340)',
  chips:       'oklch(0.64 0.090 180)',
  snacks:      'oklch(0.71 0.140 62)',
};

/** Libellés des familles, pour décrire la cargaison sans recourir à la
 *  couleur. Trois pages portent encore leur propre copie de cette table. */
export const CATEGORY_LABEL: Record<string, string> = {
  boissons: 'boissons', snacks: 'snacks', chips: 'chips',
  confiseries: 'confiseries', divers: 'divers',
};

/** Emplacements de conteneurs sur le pont. */
export const CARGO_SLOTS = 12;

/**
 * Répartit les emplacements du pont selon la composition réelle de
 * l'expédition, à la plus forte moyenne (méthode des plus forts restes) pour
 * que le total tombe exactement sur le nombre d'emplacements.
 *
 * Une expédition mono-catégorie donne une pile uniforme : c'est l'information,
 * pas un appauvrissement du visuel.
 */
export function allocateCargoSlots(
  mix: { category: string | null | undefined; quantity: number }[],
  slots: number = CARGO_SLOTS,
): string[] {
  const byCategory = new Map<string, number>();
  for (const line of mix) {
    const cat = line.category ?? 'divers';
    if (!(line.quantity > 0)) continue;
    byCategory.set(cat, (byCategory.get(cat) ?? 0) + line.quantity);
  }

  const total = [...byCategory.values()].reduce((s, q) => s + q, 0);
  if (total <= 0) return [];

  const entries = [...byCategory.entries()].map(([category, qty]) => {
    const exact = (qty / total) * slots;
    const floor = Math.floor(exact);
    return { category, qty, floor, remainder: exact - floor };
  });

  let assigned = entries.reduce((s, e) => s + e.floor, 0);
  // Les restes les plus forts emportent les emplacements qui subsistent ;
  // à égalité, la plus grosse quantité passe devant.
  const byRemainder = [...entries].sort((a, b) => b.remainder - a.remainder || b.qty - a.qty);
  for (let i = 0; assigned < slots && i < byRemainder.length * slots; i++) {
    byRemainder[i % byRemainder.length].floor++;
    assigned++;
  }

  // Catégorie dominante en premier : la pile se lit de gauche à droite.
  return entries
    .sort((a, b) => b.floor - a.floor || a.category.localeCompare(b.category))
    .flatMap(e => Array<string>(e.floor).fill(e.category));
}

export type ShipmentProgress = {
  /** 0-100, position of the boat along the route. */
  percent: number;
  /** Whole days past the ETA, 0 when on time or not applicable. */
  daysLate: number;
  late: boolean;
  /** À quai : le navire est arrivé, la mer se calme. */
  arrived: boolean;
};

/** Where the boat sits between departure and ETA. Missing dates leave it at
 *  the quayside (0%) rather than guessing a position. */
export function computeShipmentProgress(
  departureDate: string | Date | null | undefined,
  eta: string | Date | null | undefined,
  status: string,
  now: Date = new Date(),
): ShipmentProgress {
  const dep = departureDate ? new Date(departureDate).getTime() : NaN;
  const arr = eta ? new Date(eta).getTime() : NaN;
  const t = now.getTime();

  const etaKnown = Number.isFinite(arr);
  const daysLate = etaKnown && t > arr ? Math.floor((t - arr) / 86_400_000) : 0;
  const late = etaKnown && daysLate > 0 && SHIPMENT_LATE_STATUSES.includes(status);
  const arrived = SHIPMENT_ARRIVED_STATUSES.includes(status);

  // Arrivé au port : la position est acquise, quelle que soit l'ETA — un
  // navire peut accoster avec une semaine d'avance.
  if (arrived) return { percent: 100, daysLate, late: false, arrived: true };

  if (!Number.isFinite(dep) || !etaKnown || arr <= dep) {
    // Not enough to interpolate: park it at 0, or at 100 once the ETA is past.
    return { percent: etaKnown && t >= arr ? 100 : 0, daysLate, late, arrived: false };
  }

  const raw = ((t - dep) / (arr - dep)) * 100;
  return { percent: Math.min(100, Math.max(0, raw)), daysLate, late, arrived: false };
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
