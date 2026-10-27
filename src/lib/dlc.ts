import { supabaseAdmin } from './supabase';
import { fetchReservedByProduct } from './stock';
import { todayReunionISO } from './datetime';
import { REAPPRO_WEEKS_LOOKBACK, VITESSE_SHORT_HISTORY_WEEKS, effectiveHistoryWeeks } from './constants';

/**
 * Suivi des DLC par lot reçu.
 *
 * Un LOT = une ligne de réception (stock_reception_items), qui porte sa propre
 * DLC (colonne dlc, nullable). C'est de l'information de SUIVI : rien ici ne
 * modifie les quantités, le PUMP ni les réservations — ce module ne fait que lire.
 *
 * HYPOTHÈSES (à afficher à l'utilisateur, ce ne sont pas des faits tracés) :
 *  1. Le stock physique n'est pas tracé par lot. On suppose FIFO par date de
 *     réception : le plus ancien lot part en premier, donc le stock actuel se
 *     compose des lots les PLUS RÉCENTS. Un lot reçu plus tard mais à DLC plus
 *     courte (FEFO) n'est pas modélisé.
 *  2. Les quantités réservées par des commandes non livrées partent en premier,
 *     par ordre FIFO, avant l'écoulement au rythme de vente.
 *  3. Le rythme de vente est la moyenne récente du produit (10 semaines au plus,
 *     commandes confirmées → livrées), sans correction des ruptures. Sans
 *     historique de vente, il est « non estimable » : on ne conclut pas qu'un
 *     produit sans vente ne s'écoulera pas.
 *  4. Un lot sans DLC saisie est « non renseigné », jamais « sans risque ».
 */

/** En dessous de ce nombre de jours restants, un lot est « critique ». */
export const DLC_CRITIQUE_JOURS = 30;

export type LotLevel = 'perime' | 'critique' | 'a_risque' | 'non_estimable' | 'ok' | 'non_renseigne';

/** Plus petit = plus urgent. */
export const LOT_LEVEL_RANK: Record<LotLevel, number> = {
  perime: 0, critique: 1, a_risque: 2, non_estimable: 3, ok: 4, non_renseigne: 5,
};

export const LOT_LEVEL_LABEL: Record<LotLevel, string> = {
  perime: 'Périmé',
  critique: 'Critique',
  a_risque: 'À risque',
  non_estimable: 'Non estimable',
  ok: 'OK',
  non_renseigne: 'DLC non renseignée',
};

/** Niveaux qui déclenchent une alerte. */
export const ALERT_LEVELS: readonly LotLevel[] = ['perime', 'critique', 'a_risque'];

export type LotInput = {
  id: string;
  receptionId: string;
  /** AAAA-MM-JJ */
  receivedAt: string;
  /** Départage deux lots reçus le même jour. */
  createdAt: string;
  quantity: number;
  /** AAAA-MM-JJ ou null (non renseignée). */
  dlc: string | null;
};

export type LotAlert = {
  lotId: string;
  receptionId: string;
  receivedAt: string;
  dlc: string | null;
  qtyReceived: number;
  /** Quantité du lot encore en stock selon l'hypothèse FIFO (physique). */
  qtyRemaining: number;
  daysLeft: number | null;
  level: LotLevel;
  /** Cartons qui ne seront pas écoulés avant la DLC ; null si non estimable. */
  unsold: number | null;
  /** Jours nécessaires pour écouler ce lot ET ceux qui le précèdent ; null si non estimable. */
  daysToClear: number | null;
};

export type LotAnalysis = {
  lots: LotAlert[];
  /** Cartons en stock au-delà de tout ce que les réceptions expliquent (stock initial saisi à la main…). */
  stockHorsLots: number;
};

function daysBetween(fromISO: string, toISO: string): number {
  const [fy, fm, fd] = fromISO.split('-').map(Number);
  const [ty, tm, td] = toISO.split('-').map(Number);
  return Math.round((Date.UTC(ty, tm - 1, td) - Date.UTC(fy, fm - 1, fd)) / 86_400_000);
}

/** Date + n mois, ramenée au dernier jour du mois si besoin (31 janv. + 1 mois = 28/29 févr.). */
export function addMonthsISO(dateISO: string, months: number): string {
  const [y, m, d] = dateISO.split('-').map(Number);
  const total = y * 12 + (m - 1) + months;
  const ty = Math.floor(total / 12), tm = total % 12;
  const last = new Date(Date.UTC(ty, tm + 1, 0)).getUTCDate();
  return `${ty}-${String(tm + 1).padStart(2, '0')}-${String(Math.min(d, last)).padStart(2, '0')}`;
}

/**
 * Analyse les lots d'UN produit. Fonction pure (testable sans base).
 *
 * @param stock       stock physique actuel (cartons)
 * @param reserved    cartons réservés par des commandes non livrées
 * @param weeklyRate  cartons vendus par semaine, ou null si non estimable
 * @param todayISO    aujourd'hui (AAAA-MM-JJ, calendrier de La Réunion)
 */
export function analyzeLots(
  lots: LotInput[],
  stock: number,
  reserved: number,
  weeklyRate: number | null,
  todayISO: string,
): LotAnalysis {
  const ordered = [...lots]
    .filter(l => l.quantity > 0)
    .sort((a, b) => a.receivedAt.localeCompare(b.receivedAt) || a.createdAt.localeCompare(b.createdAt));

  // 1. FIFO : le stock actuel est composé des lots les plus récents.
  let left = Math.max(0, stock);
  const remaining = new Array<number>(ordered.length).fill(0);
  for (let i = ordered.length - 1; i >= 0 && left > 0; i--) {
    remaining[i] = Math.min(ordered[i].quantity, left);
    left -= remaining[i];
  }
  const stockHorsLots = left; // le plus ancien, hors de tout lot connu

  // 2. Les réservations partent en premier : d'abord le stock hors lots (le plus
  //    ancien), puis les lots du plus ancien au plus récent.
  let toShip = Math.max(0, reserved);
  const shipFromHors = Math.min(stockHorsLots, toShip);
  toShip -= shipFromHors;
  let ahead = stockHorsLots - shipFromHors; // quantité à écouler par la vente, devant le lot courant

  const perDay = weeklyRate != null && weeklyRate > 0 ? weeklyRate / 7 : null;
  const out: LotAlert[] = [];

  for (let i = 0; i < ordered.length; i++) {
    const lot = ordered[i];
    const rem = remaining[i];
    const shipped = Math.min(rem, toShip);
    toShip -= shipped;
    const pending = rem - shipped; // reste à écouler par la vente
    if (rem <= 0) continue;

    const base = {
      lotId: lot.id, receptionId: lot.receptionId, receivedAt: lot.receivedAt, dlc: lot.dlc,
      qtyReceived: lot.quantity, qtyRemaining: rem,
    };

    if (!lot.dlc) {
      out.push({ ...base, daysLeft: null, level: 'non_renseigne', unsold: null, daysToClear: null });
    } else {
      const daysLeft = daysBetween(todayISO, lot.dlc);
      let unsold: number | null = null;
      let daysToClear: number | null = null;
      if (daysLeft < 0) {
        unsold = rem; // un lot périmé ne s'écoule plus
      } else if (perDay != null) {
        const sellable = Math.min(pending, Math.max(0, perDay * daysLeft - ahead));
        unsold = Math.max(0, Math.ceil(pending - sellable - 1e-9));
        daysToClear = (ahead + pending) / perDay;
      }

      let level: LotLevel;
      if (daysLeft < 0) level = 'perime';
      else if (daysLeft < DLC_CRITIQUE_JOURS) level = 'critique';
      else if (perDay == null) level = 'non_estimable';
      else level = unsold! > 0 ? 'a_risque' : 'ok';

      out.push({ ...base, daysLeft, level, unsold, daysToClear });
    }
    ahead += pending;
  }

  return { lots: out, stockHorsLots };
}

// ── Chargement (lecture seule) ────────────────────────────────────────────

export type ProductDlc = {
  productId: string;
  productName: string;
  category: string;
  stock: number;
  reserved: number;
  /** cartons / semaine, ou null (non estimable : aucune vente sur la période). */
  weeklyRate: number | null;
  shortHistory: boolean;
  analysis: LotAnalysis;
  /** Niveau le plus urgent parmi les lots ; null si aucun lot en stock. */
  worst: LotLevel | null;
  /** Plus proche DLC parmi les lots en stock (renseignée). */
  nextDlc: string | null;
  /** Lot en alerte le plus urgent (périmé > critique > à risque, puis le moins de jours restants). */
  worstLot: LotAlert | null;
};

export type DlcOverview = {
  today: string;
  byProduct: Map<string, ProductDlc>;
  /** Lots en alerte (périmé / critique / à risque), du plus urgent au moins urgent. */
  alerts: (LotAlert & { productId: string; productName: string; weeklyRate: number | null })[];
  nonRenseigne: { lots: number; cartons: number };
  nonEstimable: { lots: number; cartons: number };
  stockHorsLots: { products: number; cartons: number };
  productsWithStock: number;
};

async function fetchAllRows<T>(
  page: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>,
): Promise<T[]> {
  const SIZE = 1000;
  const rows: T[] = [];
  for (let from = 0; ; from += SIZE) {
    const { data, error } = await page(from, from + SIZE - 1);
    if (error) throw new Error(`dlc: ${error.message}`);
    rows.push(...(data ?? []));
    if ((data?.length ?? 0) < SIZE) break;
  }
  return rows;
}

const REVENUE_STATUSES = ['confirmee', 'en_preparation', 'expediee', 'livree'];

/** Analyse tous les produits en stock (ou seulement ceux demandés). */
export async function fetchDlcOverview(productIds?: string[]): Promise<DlcOverview> {
  const today = todayReunionISO();

  let pq = supabaseAdmin
    .from('products')
    .select('id, name, category, stock_quantity, created_at')
    .gt('stock_quantity', 0);
  if (productIds && productIds.length > 0) pq = pq.in('id', productIds);
  const { data: products, error: pErr } = await pq;
  if (pErr) throw new Error(`dlc products: ${pErr.message}`);
  const prods = products ?? [];
  const ids = prods.map(p => p.id);

  const empty: DlcOverview = {
    today, byProduct: new Map(), alerts: [],
    nonRenseigne: { lots: 0, cartons: 0 }, nonEstimable: { lots: 0, cartons: 0 },
    stockHorsLots: { products: 0, cartons: 0 }, productsWithStock: 0,
  };
  if (ids.length === 0) return empty;

  type LotRow = { id: string; reception_id: string; product_id: string; quantity: number; dlc: string | null; stock_receptions: { received_at: string; created_at: string } | null };
  const lotRows = await fetchAllRows<LotRow>((a, b) =>
    supabaseAdmin
      .from('stock_reception_items')
      .select('id, reception_id, product_id, quantity, dlc, stock_receptions(received_at, created_at)')
      .in('product_id', ids)
      .order('id')
      .range(a, b) as any);

  const lookback = new Date(Date.now() - REAPPRO_WEEKS_LOOKBACK * 7 * 24 * 60 * 60 * 1000).toISOString();
  type SaleRow = { product_id: string; quantity: number; orders: { created_at: string } | null };
  const saleRows = await fetchAllRows<SaleRow>((a, b) =>
    supabaseAdmin
      .from('order_items')
      .select('product_id, quantity, orders!inner(status, created_at)')
      .in('product_id', ids)
      .in('orders.status', REVENUE_STATUSES)
      .gte('orders.created_at', lookback)
      .order('id')
      .range(a, b) as any);

  const reservedMap = await fetchReservedByProduct(ids);

  const lotsBy = new Map<string, LotInput[]>();
  const firstReception = new Map<string, string>();
  for (const r of lotRows) {
    const rec = r.stock_receptions;
    if (!rec) continue;
    const list = lotsBy.get(r.product_id) ?? [];
    list.push({ id: r.id, receptionId: r.reception_id, receivedAt: rec.received_at, createdAt: rec.created_at, quantity: r.quantity, dlc: r.dlc });
    lotsBy.set(r.product_id, list);
    const cur = firstReception.get(r.product_id);
    if (!cur || rec.received_at < cur) firstReception.set(r.product_id, rec.received_at);
  }
  const salesBy = new Map<string, SaleRow[]>();
  for (const s of saleRows) {
    const list = salesBy.get(s.product_id) ?? [];
    list.push(s);
    salesBy.set(s.product_id, list);
  }

  const out: DlcOverview = { ...empty, productsWithStock: prods.length };

  for (const p of prods) {
    // « Vendable depuis » : le plus tardif de la création et de la 1re réception
    // (même convention que /admin/commande-fournisseur).
    const recv = firstReception.get(p.id);
    const sellableSince = recv && recv > p.created_at ? recv : p.created_at;
    const sinceMs = new Date(sellableSince).getTime();
    const qty = (salesBy.get(p.id) ?? [])
      .filter(s => s.orders && new Date(s.orders.created_at).getTime() >= sinceMs)
      .reduce((sum, s) => sum + s.quantity, 0);
    const weeks = effectiveHistoryWeeks(sellableSince);
    const weeklyRate = qty > 0 ? qty / weeks : null;

    const reserved = reservedMap.get(p.id) ?? 0;
    const analysis = analyzeLots(lotsBy.get(p.id) ?? [], p.stock_quantity, reserved, weeklyRate, today);

    let worst: LotLevel | null = null;
    let nextDlc: string | null = null;
    let worstLot: LotAlert | null = null;
    for (const l of analysis.lots) {
      if (worst == null || LOT_LEVEL_RANK[l.level] < LOT_LEVEL_RANK[worst]) worst = l.level;
      if (l.dlc && (nextDlc == null || l.dlc < nextDlc)) nextDlc = l.dlc;
      if (l.level === 'non_renseigne') { out.nonRenseigne.lots++; out.nonRenseigne.cartons += l.qtyRemaining; }
      if (l.level === 'non_estimable') { out.nonEstimable.lots++; out.nonEstimable.cartons += l.qtyRemaining; }
      if (ALERT_LEVELS.includes(l.level)) {
        out.alerts.push({ ...l, productId: p.id, productName: p.name, weeklyRate });
        if (!worstLot || LOT_LEVEL_RANK[l.level] < LOT_LEVEL_RANK[worstLot.level]
            || (l.level === worstLot.level && (l.daysLeft ?? 0) < (worstLot.daysLeft ?? 0))) worstLot = l;
      }
    }
    if (analysis.stockHorsLots > 0) {
      out.stockHorsLots.products++;
      out.stockHorsLots.cartons += analysis.stockHorsLots;
    }

    out.byProduct.set(p.id, {
      productId: p.id, productName: p.name, category: p.category, stock: p.stock_quantity, reserved,
      weeklyRate, shortHistory: weeks < VITESSE_SHORT_HISTORY_WEEKS && weeklyRate != null,
      analysis, worst, nextDlc, worstLot,
    });
  }

  out.alerts.sort((a, b) =>
    LOT_LEVEL_RANK[a.level] - LOT_LEVEL_RANK[b.level]
    || (a.daysLeft ?? 0) - (b.daysLeft ?? 0)
    || (b.unsold ?? 0) - (a.unsold ?? 0));

  return out;
}

/**
 * Lit une DLC saisie dans un formulaire : AAAA-MM-JJ valide (année 2000–2100),
 * sinon null (« non renseignée »). Une valeur vide ou invalide ne bloque jamais
 * l'enregistrement d'une réception : la DLC est optionnelle.
 */
export function parseDlc(raw: string | null | undefined): string | null {
  const s = (raw ?? '').trim();
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return null;
  const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
  if (y < 2000 || y > 2100) return null;
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d ? s : null;
}

// ── Pastille par produit (listes /admin/stocks et /admin/produits) ───────────

export type DlcBadge = { level: LotLevel; label: string; title: string };

/** Pastille du lot le plus urgent d'un produit ; null si aucun lot en alerte. */
export function dlcBadge(pd: ProductDlc): DlcBadge | null {
  const l = pd.worstLot;
  if (!l) return null;
  const fmt = (iso: string) => iso.split('-').reverse().join('/');
  const days = l.daysLeft == null ? '' : l.daysLeft < 0 ? `périmé depuis ${-l.daysLeft} j` : `${l.daysLeft} j restants`;
  const unsold = l.level === 'perime'
    ? `${l.qtyRemaining} carton(s) périmé(s) encore en stock`
    : l.unsold == null
      ? "risque d'invendu non estimable (aucune vente récente)"
      : `non écoulé estimé : ${l.unsold} carton(s)`;
  const more = pd.analysis.lots.filter(x => ALERT_LEVELS.includes(x.level)).length - 1;
  const extra = more > 0 ? ` · +${more} autre(s) lot(s) en alerte` : '';
  return {
    level: l.level,
    label: LOT_LEVEL_LABEL[l.level],
    title: `Lot reçu le ${fmt(l.receivedAt)} · DLC ${fmt(l.dlc!)} (${days}) · ${l.qtyRemaining} carton(s) · ${unsold}${extra}. Hypothèse FIFO, voir le tableau de bord.`,
  };
}

/** Pastilles de tous les produits en alerte. Un échec renvoie une carte vide : une liste ne doit jamais casser pour ça. */
export async function fetchDlcBadges(): Promise<Map<string, DlcBadge>> {
  const out = new Map<string, DlcBadge>();
  try {
    const overview = await fetchDlcOverview();
    for (const [id, pd] of overview.byProduct) {
      const b = dlcBadge(pd);
      if (b) out.set(id, b);
    }
  } catch (err) {
    console.error('[dlc] pastilles indisponibles:', (err as Error).message);
  }
  return out;
}
