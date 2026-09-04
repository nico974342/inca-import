import { supabaseAdmin } from './supabase';
import { reunionDateStartUTC, reunionMonthStart, formatDateReunion } from './datetime';

export type ChargeCategorie =
  | 'loyer' | 'assurance' | 'frais_bancaires' | 'remboursement_emprunt'
  | 'salaires' | 'vehicule' | 'telecom' | 'logiciels' | 'autre';

export const CHARGE_CATEGORIES: readonly ChargeCategorie[] = [
  'loyer', 'assurance', 'frais_bancaires', 'remboursement_emprunt',
  'salaires', 'vehicule', 'telecom', 'logiciels', 'autre',
];

export const CHARGE_CATEGORY_LABEL: Record<ChargeCategorie, string> = {
  loyer: 'Loyer',
  assurance: 'Assurance',
  frais_bancaires: 'Frais bancaires',
  remboursement_emprunt: 'Remboursement emprunt',
  salaires: 'Salaires',
  vehicule: 'Véhicule',
  telecom: 'Télécom',
  logiciels: 'Logiciels',
  autre: 'Autre',
};

export type ChargePeriodicite = 'mensuelle' | 'trimestrielle' | 'annuelle' | 'ponctuelle';

export const CHARGE_PERIODICITES: readonly ChargePeriodicite[] = ['mensuelle', 'trimestrielle', 'annuelle', 'ponctuelle'];

export const CHARGE_PERIODICITE_LABEL: Record<ChargePeriodicite, string> = {
  mensuelle: 'Mensuelle',
  trimestrielle: 'Trimestrielle',
  annuelle: 'Annuelle',
  ponctuelle: 'Ponctuelle (un seul mois)',
};

export type Charge = {
  id: string;
  libelle: string;
  categorie: ChargeCategorie;
  montant_ht: number;
  periodicite: ChargePeriodicite;
  date_debut: string;
  date_fin: string | null;
  notes: string | null;
  created_at: string;
};

const REVENUE_STATUSES = ['confirmee', 'en_preparation', 'expediee', 'livree'] as const;

/** Nombre de mois d'historique utilisés pour la marge moyenne du prévisionnel
 *  — source unique pour /admin/marges et l'export, pour qu'ils s'accordent. */
export const MONTHS_HISTORY_FOR_PROJECTION = 3;

/** Horizon du prévisionnel, en mois. */
export const MONTHS_AHEAD_FOR_PROJECTION = 6;

export async function fetchCharges(): Promise<Charge[]> {
  const { data, error } = await supabaseAdmin
    .from('charges')
    .select('id, libelle, categorie, montant_ht, periodicite, date_debut, date_fin, notes, created_at')
    .order('categorie', { ascending: true })
    .order('libelle', { ascending: true });
  if (error) throw new Error(`fetchCharges: ${error.message}`);
  return (data ?? []).map(r => ({ ...r, montant_ht: Number(r.montant_ht) })) as Charge[];
}

/** Équivalent mensuel d'une charge, indépendamment de sa période d'activité —
 *  voir isChargeActiveInMonth pour savoir SI elle compte pour un mois donné. */
export function chargeMonthlyEquivalent(charge: Pick<Charge, 'montant_ht' | 'periodicite'>): number {
  switch (charge.periodicite) {
    case 'mensuelle': return charge.montant_ht;
    case 'trimestrielle': return charge.montant_ht / 3;
    case 'annuelle': return charge.montant_ht / 12;
    case 'ponctuelle': return charge.montant_ht;
  }
}

/** Une charge ponctuelle ne compte que sur le mois de date_debut. Les
 *  récurrentes comptent tant que le mois est dans [date_debut, date_fin]
 *  (date_fin nulle = toujours en cours). */
export function isChargeActiveInMonth(
  charge: Pick<Charge, 'periodicite' | 'date_debut' | 'date_fin'>,
  monthStart: Date,
  monthEndExclusive: Date,
): boolean {
  const debut = reunionDateStartUTC(charge.date_debut);

  if (charge.periodicite === 'ponctuelle') {
    return debut >= monthStart && debut < monthEndExclusive;
  }

  if (debut >= monthEndExclusive) return false; // pas encore commencée
  if (charge.date_fin != null) {
    const fin = reunionDateStartUTC(charge.date_fin);
    if (fin < monthStart) return false; // déjà clôturée avant ce mois
  }
  return true;
}

export function computeMonthlyChargesTotal(charges: Charge[], monthStart: Date, monthEndExclusive: Date): number {
  return charges.reduce(
    (sum, c) => (isChargeActiveInMonth(c, monthStart, monthEndExclusive) ? sum + chargeMonthlyEquivalent(c) : sum),
    0,
  );
}

export type ChargeCategoryTotal = { categorie: ChargeCategorie; label: string; total: number; charges: Charge[] };

/** Regroupe les charges actives sur un mois donné par catégorie, avec le
 *  total mensuel équivalent de chacune. N'inclut que les catégories ayant
 *  au moins une charge active ce mois-là. */
export function groupActiveChargesByCategory(
  charges: Charge[],
  monthStart: Date,
  monthEndExclusive: Date,
): ChargeCategoryTotal[] {
  const active = charges.filter(c => isChargeActiveInMonth(c, monthStart, monthEndExclusive));
  return CHARGE_CATEGORIES
    .map(categorie => {
      const inCat = active.filter(c => c.categorie === categorie);
      return {
        categorie,
        label: CHARGE_CATEGORY_LABEL[categorie],
        total: inCat.reduce((s, c) => s + chargeMonthlyEquivalent(c), 0),
        charges: inCat,
      };
    })
    .filter(g => g.charges.length > 0);
}

export type BreakEven = { value: number; source: 'calcule' | 'manuel' };

/** Point mort : somme des charges actives sur le mois de référence si au
 *  moins une charge est saisie, sinon repli sur la constante manuelle
 *  (MONTHLY_MARGIN_BREAKEVEN_FALLBACK dans lib/constants.ts). */
export function resolveBreakEven(
  charges: Charge[],
  monthStart: Date,
  monthEndExclusive: Date,
  fallback: number,
): BreakEven {
  const total = computeMonthlyChargesTotal(charges, monthStart, monthEndExclusive);
  return total > 0 ? { value: total, source: 'calcule' } : { value: fallback, source: 'manuel' };
}

/**
 * Charges d'une période arbitraire (export), au prorata du nombre de jours
 * de chaque mois civil couverts par [debut, fin] — une charge mensuelle
 * n'est pas comptée en entier si la période ne couvre que 10 jours de son
 * mois. debut/fin en "AAAA-MM-JJ", calendrier de La Réunion, bornes incluses.
 */
export function computeChargesForPeriod(charges: Charge[], debut: string, fin: string): number {
  const [dY, dM] = debut.split('-').map(Number);
  const [fY, fM] = fin.split('-').map(Number);
  const debutDate = reunionDateStartUTC(debut);
  const finDateExclusive = new Date(reunionDateStartUTC(fin).getTime() + 86_400_000);

  const monthStartFromYM = (y: number, m: number) => new Date(`${y}-${String(m).padStart(2, '0')}-01T00:00:00+04:00`);

  let total = 0;
  let y = dY, m = dM;
  while (y < fY || (y === fY && m <= fM)) {
    const monthStart = monthStartFromYM(y, m);
    const nextY = m === 12 ? y + 1 : y;
    const nextM = m === 12 ? 1 : m + 1;
    const monthEndExclusive = monthStartFromYM(nextY, nextM);

    const overlapStart = Math.max(monthStart.getTime(), debutDate.getTime());
    const overlapEnd = Math.min(monthEndExclusive.getTime(), finDateExclusive.getTime());
    const overlapDays = Math.max(0, (overlapEnd - overlapStart) / 86_400_000);
    const daysInMonth = (monthEndExclusive.getTime() - monthStart.getTime()) / 86_400_000;

    if (overlapDays > 0) {
      total += computeMonthlyChargesTotal(charges, monthStart, monthEndExclusive) * (overlapDays / daysInMonth);
    }

    y = nextY; m = nextM;
  }
  return total;
}

/**
 * Marge des N derniers mois CIVILS COMPLETS (avant le mois en cours), un par
 * mois ayant eu au moins une commande — les mois antérieurs au démarrage de
 * l'activité sont omis plutôt que comptés comme des zéros, pour ne pas tirer
 * la moyenne vers le bas. Plus ancien en premier.
 *
 * Utilisé par l'export, qui n'a pas déjà ces chiffres sous la main comme
 * /admin/marges (qui les extrait plutôt de son propre tableau 12 mois, déjà
 * chargé, pour éviter une requête redondante).
 */
export async function fetchRecentCompleteMonthMargins(monthsBack: number): Promise<number[]> {
  const windowStart = reunionMonthStart(monthsBack);
  const currentMonthStart = reunionMonthStart(0);

  const { data, error } = await supabaseAdmin
    .from('orders')
    .select('created_at, order_items(quantity, price_ht_snapshot, pump_snapshot)')
    .in('status', REVENUE_STATUSES as readonly string[])
    .gte('created_at', windowStart.toISOString())
    .lt('created_at', currentMonthStart.toISOString());
  if (error) throw new Error(`fetchRecentCompleteMonthMargins: ${error.message}`);

  const bounds = Array.from({ length: monthsBack }, (_, k) => {
    const i = k + 1;
    return { i, start: reunionMonthStart(i).getTime(), end: reunionMonthStart(i - 1).getTime() };
  });

  const margeByMonthsAgo = new Map<number, number>();
  const orderCountByMonthsAgo = new Map<number, number>();

  for (const order of data ?? []) {
    const ts = new Date(order.created_at).getTime();
    const bucket = bounds.find(b => ts >= b.start && ts < b.end);
    if (!bucket) continue;
    orderCountByMonthsAgo.set(bucket.i, (orderCountByMonthsAgo.get(bucket.i) ?? 0) + 1);
    let marge = margeByMonthsAgo.get(bucket.i) ?? 0;
    for (const item of (order as any).order_items ?? []) {
      const prix = item.price_ht_snapshot != null ? Number(item.price_ht_snapshot) : null;
      const pump = item.pump_snapshot != null ? Number(item.pump_snapshot) : null;
      if (prix != null && pump != null) marge += (prix - pump) * item.quantity;
    }
    margeByMonthsAgo.set(bucket.i, marge);
  }

  const result: number[] = [];
  for (let i = monthsBack; i >= 1; i--) {
    if ((orderCountByMonthsAgo.get(i) ?? 0) > 0) result.push(margeByMonthsAgo.get(i) ?? 0);
  }
  return result;
}

export type ProjectionMonth = {
  label: string;
  margePrevisionnelle: number;
  chargesPrevisionnelles: number;
  resultatNet: number;
  cumule: number;
};

export type ProjectionResult = {
  months: ProjectionMonth[];
  avgMargeHistorique: number;
  moisUtilisesPourMoyenne: number;
  coefficientPct: number;
  margePrevisionnelleMensuelle: number;
  /** Index 1-based dans `months` à partir duquel le résultat net reste
   *  positif ou nul jusqu'à la fin de l'horizon — null si ça n'arrive pas
   *  dans l'horizon projeté. */
  moisSeuilDurable: number | null;
};

/**
 * Projette marge (moyenne historique × coefficient, CONSTANTE sur tout
 * l'horizon) et charges (variables mois par mois selon les dates de
 * fin déjà saisies) sur les prochains mois.
 */
export function projectCharges(
  chargesActuelles: Charge[],
  historicalMonthMargins: number[],
  coefficientPct: number,
  monthsAhead: number = MONTHS_AHEAD_FOR_PROJECTION,
): ProjectionResult {
  const avgMargeHistorique = historicalMonthMargins.length > 0
    ? historicalMonthMargins.reduce((s, v) => s + v, 0) / historicalMonthMargins.length
    : 0;
  const margePrevisionnelleMensuelle = avgMargeHistorique * (coefficientPct / 100);

  const months: ProjectionMonth[] = [];
  let cumule = 0;
  for (let i = 1; i <= monthsAhead; i++) {
    const monthStart = reunionMonthStart(-i);
    const monthEndExclusive = reunionMonthStart(-(i + 1));
    const rawLabel = formatDateReunion(monthStart, { day: undefined, year: undefined, month: 'short' }).replace('.', '');
    const label = rawLabel.charAt(0).toUpperCase() + rawLabel.slice(1);

    const chargesPrevisionnelles = computeMonthlyChargesTotal(chargesActuelles, monthStart, monthEndExclusive);
    const resultatNet = margePrevisionnelleMensuelle - chargesPrevisionnelles;
    cumule += resultatNet;
    months.push({ label, margePrevisionnelle: margePrevisionnelleMensuelle, chargesPrevisionnelles, resultatNet, cumule });
  }

  let moisSeuilDurable: number | null = null;
  for (let i = 0; i < months.length; i++) {
    if (months.slice(i).every(m => m.resultatNet >= 0)) { moisSeuilDurable = i + 1; break; }
  }

  return {
    months,
    avgMargeHistorique,
    moisUtilisesPourMoyenne: historicalMonthMargins.length,
    coefficientPct,
    margePrevisionnelleMensuelle,
    moisSeuilDurable,
  };
}
