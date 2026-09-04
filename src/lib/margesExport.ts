import { supabaseAdmin } from './supabase';
import { fetchAvailability } from './stock';
import { formatDateReunion, formatDateTimeReunion, reunionDateStartUTC } from './datetime';
import { CATEGORY_LABEL, ORDER_STATUS_LABEL } from './constants';
import {
  fetchCharges, computeChargesForPeriod, projectCharges, fetchRecentCompleteMonthMargins,
  MONTHS_HISTORY_FOR_PROJECTION, MONTHS_AHEAD_FOR_PROJECTION,
} from './charges';

/**
 * Statuts inclus dans l'export — mêmes bornes que /admin/marges, à ne pas
 * faire dériver : "en_attente" n'a rien réservé qui vaille d'être compté en
 * CA, "annulee" est une non-vente.
 */
const EXPORT_STATUSES = ['confirmee', 'en_preparation', 'expediee', 'livree'] as const;

/**
 * Au-delà de cette taille, coller l'export dans une conversation devient
 * pénible pour beaucoup d'interfaces de chat (même quand le modèle
 * accepterait largement plus) — on avertit plutôt que de laisser découvrir
 * le problème après coup.
 */
export const EXPORT_SIZE_WARNING_CHARS = 150_000;

export type MargesExportResult = {
  markdown: string;
  sizeChars: number;
};

/** Borne de fin exclusive : minuit du lendemain du dernier jour inclus. */
function reunionDayEndExclusiveUTC(dateStr: string): Date {
  const d = reunionDateStartUTC(dateStr);
  d.setUTCDate(d.getUTCDate() + 1);
  return d;
}

function fmt2(n: number): string {
  return n.toFixed(2);
}

function eur(n: number): string {
  return `${fmt2(n)} €`;
}

function pct(n: number | null): string {
  return n == null ? '—' : `${n.toFixed(1)} %`;
}

/** Échappe les caractères qui casseraient une cellule de tableau markdown. */
function cell(value: string | number | null | undefined): string {
  if (value == null) return '—';
  return String(value).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ').trim() || '—';
}

function mdTable(headers: string[], rows: (string | number | null | undefined)[][]): string {
  if (rows.length === 0) {
    return `${headers.map(cell).join(' | ')}\n${headers.map(() => '---').join(' | ')}\n_Aucune donnée sur la période._\n`;
  }
  const head = `| ${headers.map(cell).join(' | ')} |`;
  const sep = `| ${headers.map(() => '---').join(' | ')} |`;
  const body = rows.map(r => `| ${r.map(cell).join(' | ')} |`).join('\n');
  return `${head}\n${sep}\n${body}\n`;
}

function conditionnement(unit: string | null, unitsPerCarton: number | null): string {
  if (unitsPerCarton != null) return `${unitsPerCarton} unités/${unit ?? 'carton'}`;
  return unit ?? 'carton';
}

type OrderItemRow = {
  product_id: string | null;
  product_name: string;
  quantity: number;
  unit: string | null;
  price_ht_snapshot: number | null;
  pump_snapshot: number | null;
};

type OrderRow = {
  id: string;
  created_at: string;
  nom: string | null;
  societe: string | null;
  email: string | null;
  status: string;
  order_items: OrderItemRow[];
};

/** Validation légère des bornes reçues du formulaire (YYYY-MM-DD, calendrier Réunion). */
export function isValidDateStr(s: string | null | undefined): s is string {
  return !!s && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(reunionDateStartUTC(s).getTime());
}

export async function buildMargesExport(debut: string, fin: string, coefPct: number = 100): Promise<MargesExportResult> {
  const startISO = reunionDateStartUTC(debut).toISOString();
  const endISOExclusive = reunionDayEndExclusiveUTC(fin).toISOString();
  const nbJours = Math.round((reunionDayEndExclusiveUTC(fin).getTime() - reunionDateStartUTC(debut).getTime()) / 86_400_000);

  const [
    { data: ordersRaw },
    { data: productsRaw },
    { data: receptionsRaw },
    { data: clientsRaw },
    { data: priceGroupsRaw },
    { data: firstOrderRaw },
    charges,
    historicalMonthMargins,
  ] = await Promise.all([
    supabaseAdmin
      .from('orders')
      .select('id, created_at, nom, societe, email, status, order_items(product_id, product_name, quantity, unit, price_ht_snapshot, pump_snapshot)')
      .in('status', EXPORT_STATUSES as readonly string[])
      .gte('created_at', startISO)
      .lt('created_at', endISOExclusive)
      .order('created_at', { ascending: true }),
    supabaseAdmin
      .from('products')
      .select('id, name, sku, category, unit, units_per_carton, stock_quantity, prix_achat_moyen_ht, in_stock')
      .order('category', { ascending: true })
      .order('name', { ascending: true }),
    supabaseAdmin
      .from('stock_receptions')
      .select('id, supplier_name, received_at, stock_reception_items(product_id, quantity, unit_cost_ht)')
      .gte('received_at', debut)
      .lte('received_at', fin)
      .order('received_at', { ascending: true }),
    supabaseAdmin
      .from('client_accounts')
      .select('id, nom, societe, email, points_de_vente, price_group_id, remise'),
    supabaseAdmin.from('price_groups').select('id, name, is_default'),
    supabaseAdmin.from('orders').select('created_at').order('created_at', { ascending: true }).limit(1),
    fetchCharges(),
    fetchRecentCompleteMonthMargins(MONTHS_HISTORY_FOR_PROJECTION),
  ]);

  const orders = (ordersRaw ?? []) as unknown as OrderRow[];
  const products = productsRaw ?? [];
  const receptions = receptionsRaw ?? [];
  const clients = clientsRaw ?? [];
  const priceGroups = priceGroupsRaw ?? [];

  const productById = new Map(products.map(p => [p.id, p]));
  const priceGroupById = new Map(priceGroups.map(g => [g.id, g.name as string]));
  const defaultPriceGroup = priceGroups.find(g => g.is_default);

  // ── Disponibilité actuelle (physique − réservé). Calculée au moment de la
  //    génération, pas historisée — voir la section Limites en pied d'export.
  const availability = await fetchAvailability(products as { id: string; stock_quantity: number | null }[]);

  // ── Ventes par produit ──────────────────────────────────────────────────
  type ProdAgg = {
    productId: string | null;
    name: string;
    sku: string | null;
    category: string | null;
    unit: string | null;
    unitsPerCarton: number | null;
    cartons: number;
    caHt: number;
    costHt: number;
    hasMissingCost: boolean;
  };
  const prodAggByKey = new Map<string, ProdAgg>();

  for (const order of orders) {
    for (const item of order.order_items ?? []) {
      const key = item.product_id ?? `nom:${item.product_name}`;
      const meta = item.product_id ? productById.get(item.product_id) : undefined;
      let agg = prodAggByKey.get(key);
      if (!agg) {
        agg = {
          productId: item.product_id,
          name: meta?.name ?? item.product_name,
          sku: meta?.sku ?? null,
          category: meta?.category ?? null,
          unit: meta?.unit ?? item.unit,
          unitsPerCarton: meta?.units_per_carton ?? null,
          cartons: 0, caHt: 0, costHt: 0, hasMissingCost: false,
        };
        prodAggByKey.set(key, agg);
      }
      const qty = item.quantity ?? 0;
      const prix = item.price_ht_snapshot != null ? Number(item.price_ht_snapshot) : null;
      const pump = item.pump_snapshot != null ? Number(item.pump_snapshot) : null;
      agg.cartons += qty;
      if (prix != null) agg.caHt += prix * qty;
      if (pump != null) agg.costHt += pump * qty;
      else agg.hasMissingCost = true;
    }
  }

  const produitAggs = [...prodAggByKey.values()].sort((a, b) => b.caHt - a.caHt);
  const produitsSansCoutCount = produitAggs.filter(p => p.hasMissingCost).length;

  const ventesParProduitRows = produitAggs.map(p => {
    const margeHt = p.caHt - p.costHt;
    const margePct = p.caHt > 0 ? (margeHt / p.caHt) * 100 : null;
    const prixMoyen = p.cartons > 0 ? p.caHt / p.cartons : null;
    const unitesVendues = p.unitsPerCarton != null ? p.cartons * p.unitsPerCarton : null;
    const avail = p.productId ? availability.get(p.productId) : undefined;
    return [
      p.name + (p.hasMissingCost ? ' †' : ''),
      p.sku,
      p.category ? (CATEGORY_LABEL[p.category] ?? p.category) : null,
      conditionnement(p.unit, p.unitsPerCarton),
      p.cartons,
      unitesVendues ?? '—',
      prixMoyen != null ? eur(prixMoyen) : '—',
      eur(p.caHt),
      eur(p.costHt),
      eur(margeHt),
      pct(margePct),
      avail ? avail.available : '—',
    ];
  });

  // ── Ventes par client ───────────────────────────────────────────────────
  const clientByEmail = new Map(clients.filter(c => c.email).map(c => [c.email!.toLowerCase(), c]));

  type ClientAgg = {
    key: string;
    nom: string; societe: string | null; email: string | null;
    orders: OrderRow[];
    cartons: number; caHt: number; margeHt: number;
  };
  const clientAggByKey = new Map<string, ClientAgg>();

  for (const order of orders) {
    const key = order.email ? `email:${order.email.toLowerCase()}` : `anon:${order.nom ?? ''}|${order.societe ?? ''}`;
    let agg = clientAggByKey.get(key);
    if (!agg) {
      agg = { key, nom: order.nom ?? '—', societe: order.societe ?? null, email: order.email ?? null, orders: [], cartons: 0, caHt: 0, margeHt: 0 };
      clientAggByKey.set(key, agg);
    }
    agg.orders.push(order);
    for (const item of order.order_items ?? []) {
      const qty = item.quantity ?? 0;
      const prix = item.price_ht_snapshot != null ? Number(item.price_ht_snapshot) : null;
      const pump = item.pump_snapshot != null ? Number(item.pump_snapshot) : null;
      agg.cartons += qty;
      if (prix != null) agg.caHt += prix * qty;
      if (prix != null && pump != null) agg.margeHt += (prix - pump) * qty;
    }
  }

  const clientAggs = [...clientAggByKey.values()].sort((a, b) => b.caHt - a.caHt);

  const ventesParClientRows = clientAggs.map(c => {
    const compte = c.email ? clientByEmail.get(c.email.toLowerCase()) : undefined;
    const groupeLabel = compte?.price_group_id
      ? (priceGroupById.get(compte.price_group_id) ?? '—')
      : (defaultPriceGroup ? `${defaultPriceGroup.name} (par défaut)` : '—');
    const dates = c.orders.map(o => new Date(o.created_at).getTime());
    const premiere = formatDateReunion(new Date(Math.min(...dates)));
    const derniere = formatDateReunion(new Date(Math.max(...dates)));
    const panierMoyen = c.orders.length > 0 ? c.caHt / c.orders.length : 0;
    return [
      compte?.nom ?? c.nom,
      compte?.societe ?? c.societe,
      compte?.points_de_vente ?? null,
      groupeLabel,
      compte?.remise != null ? `${compte.remise} %` : '—',
      c.orders.length,
      c.cartons,
      eur(c.caHt),
      eur(c.margeHt),
      eur(panierMoyen),
      premiere,
      derniere,
    ];
  });

  const clientsActifsCount = clientAggs.length;

  // ── Détail des commandes ────────────────────────────────────────────────
  const detailCommandesRows = orders.map(o => {
    let cartons = 0, totalHt = 0, margeHt = 0;
    for (const item of o.order_items ?? []) {
      const qty = item.quantity ?? 0;
      const prix = item.price_ht_snapshot != null ? Number(item.price_ht_snapshot) : null;
      const pump = item.pump_snapshot != null ? Number(item.pump_snapshot) : null;
      cartons += qty;
      if (prix != null) totalHt += prix * qty;
      if (prix != null && pump != null) margeHt += (prix - pump) * qty;
    }
    return [
      formatDateReunion(o.created_at),
      o.societe || o.nom || '—',
      ORDER_STATUS_LABEL[o.status as keyof typeof ORDER_STATUS_LABEL] ?? o.status,
      (o.order_items ?? []).length,
      cartons,
      eur(totalHt),
      eur(margeHt),
    ];
  });

  // ── Réceptions fournisseurs de la période ──────────────────────────────
  const receptionRows: (string | number)[][] = [];
  for (const r of receptions) {
    for (const item of (r as any).stock_reception_items ?? []) {
      const produit = productById.get(item.product_id);
      const qty = item.quantity ?? 0;
      const unitCost = Number(item.unit_cost_ht ?? 0);
      receptionRows.push([
        formatDateReunion(r.received_at),
        r.supplier_name,
        produit?.name ?? 'Produit supprimé',
        qty,
        eur(unitCost),
        eur(unitCost * qty),
      ]);
    }
  }
  receptionRows.sort((a, b) => String(a[0]).localeCompare(String(b[0])));

  // ── Stock à date ────────────────────────────────────────────────────────
  let produitsSansPumpCatalogue = 0;
  let valeurStock = 0;
  const stockRows = products.map(p => {
    const avail = availability.get(p.id);
    const pump = p.prix_achat_moyen_ht != null ? Number(p.prix_achat_moyen_ht) : null;
    if (pump == null) produitsSansPumpCatalogue++;
    const valeur = (avail?.physical ?? 0) * (pump ?? 0);
    valeurStock += valeur;
    return [
      p.name,
      p.sku,
      CATEGORY_LABEL[p.category] ?? p.category,
      avail?.physical ?? 0,
      avail?.reserved ?? 0,
      avail?.available ?? 0,
      pump != null ? eur(pump) : '—',
      eur(valeur),
    ];
  });

  // ── Totaux ──────────────────────────────────────────────────────────────
  const totalCaHt = produitAggs.reduce((s, p) => s + p.caHt, 0);
  const totalCostHt = produitAggs.reduce((s, p) => s + p.costHt, 0);
  const totalMargeHt = totalCaHt - totalCostHt;
  const totalMargePct = totalCaHt > 0 ? (totalMargeHt / totalCaHt) * 100 : null;
  const totalCartons = produitAggs.reduce((s, p) => s + p.cartons, 0);

  // Charges au prorata des jours de la période dans chaque mois civil — voir
  // computeChargesForPeriod pour la méthode exacte.
  const chargesPeriode = computeChargesForPeriod(charges, debut, fin);
  const resultatNetPeriode = totalMargeHt - chargesPeriode;
  const resultatPctPeriode = totalCaHt > 0 ? (resultatNetPeriode / totalCaHt) * 100 : null;

  // ── Prévisionnel — mêmes règles que /admin/marges (lib/charges.ts) ───────
  const projection = projectCharges(charges, historicalMonthMargins, coefPct, MONTHS_AHEAD_FOR_PROJECTION);

  // ── Limites des données ─────────────────────────────────────────────────
  const firstOrderDate = firstOrderRaw?.[0]?.created_at ? new Date(firstOrderRaw[0].created_at) : null;
  const historiqueJours = firstOrderDate ? Math.round((Date.now() - firstOrderDate.getTime()) / 86_400_000) : null;

  const genere = formatDateTimeReunion(new Date());

  const parts: string[] = [];

  parts.push('# Export brut — Historique des marges (Inca Import)\n');
  parts.push(
    `- Période couverte : ${formatDateReunion(reunionDateStartUTC(debut))} → ${formatDateReunion(reunionDateStartUTC(fin))} (${nbJours} jour${nbJours > 1 ? 's' : ''})\n` +
    `- Généré le ${genere} (heure de La Réunion)\n` +
    `- Statuts de commande inclus : Confirmée, En préparation, Expédiée, Livrée\n` +
    `- Commandes sur la période : ${orders.length}\n` +
    `- Clients actifs sur la période (au moins une commande) : ${clientsActifsCount}\n` +
    `- Produits vendus sur la période : ${produitAggs.length}\n`
  );

  parts.push('\n## Totaux\n');
  parts.push('_Charges et résultat net au prorata des jours de la période dans chaque mois civil — voir Limites des données._\n\n');
  parts.push(mdTable(
    ['Indicateur', 'Valeur'],
    [
      ['CA HT', eur(totalCaHt)],
      ['Coût HT', eur(totalCostHt)],
      ['Marge HT', eur(totalMargeHt)],
      ['Marge %', pct(totalMargePct)],
      ['Charges (période, au prorata)', eur(chargesPeriode)],
      ['Résultat net (période)', eur(resultatNetPeriode)],
      ['Résultat %', pct(resultatPctPeriode)],
      ['Cartons vendus', totalCartons],
      ['Valeur du stock (à la génération)', eur(valeurStock)],
    ],
  ));

  parts.push('\n## Ventes par produit\n');
  parts.push('_† = au moins une vente sans coût d\'achat connu ; coût et marge sous-estimés pour cette ligne, voir Limites des données._\n\n');
  parts.push(mdTable(
    ['Produit', 'SKU', 'Catégorie', 'Conditionnement', 'Cartons vendus', 'Unités vendues', 'Prix de vente moyen HT', 'CA HT', 'Coût HT', 'Marge HT', 'Marge %', 'Stock disponible'],
    ventesParProduitRows,
  ));

  parts.push('\n## Ventes par client\n');
  parts.push(mdTable(
    ['Client', 'Société', 'Point de vente', 'Groupe tarifaire', 'Remise', 'Commandes', 'Cartons', 'CA HT', 'Marge HT', 'Panier moyen', 'Première commande (période)', 'Dernière commande (période)'],
    ventesParClientRows,
  ));

  parts.push('\n## Détail des commandes\n');
  parts.push(mdTable(
    ['Date', 'Client', 'Statut', 'Lignes', 'Cartons', 'Total HT', 'Marge HT'],
    detailCommandesRows,
  ));

  parts.push('\n## Réceptions fournisseurs (période)\n');
  parts.push(mdTable(
    ['Date', 'Fournisseur', 'Produit', 'Quantité', 'Coût unitaire HT', 'Coût total HT'],
    receptionRows,
  ));

  parts.push('\n## Stock à date\n');
  parts.push('_Stock au moment de la génération de cet export — le système ne conserve pas d\'historique de stock quotidien, ces chiffres ne représentent donc pas forcément l\'état exact à la fin de la période sélectionnée si celle-ci est déjà passée._\n\n');
  parts.push(mdTable(
    ['Produit', 'SKU', 'Catégorie', 'Physique', 'Réservé', 'Disponible', 'Coût moyen unitaire HT', 'Valeur du stock HT'],
    stockRows,
  ));

  parts.push(`\n## Prévisionnel — ${MONTHS_AHEAD_FOR_PROJECTION} prochains mois\n`);
  if (historicalMonthMargins.length === 0) {
    parts.push(`Pas assez d'historique pour projeter : aucun des ${MONTHS_HISTORY_FOR_PROJECTION} mois précédant le mois en cours n'a encore de commande.\n`);
  } else {
    parts.push(
      `Marge prévisionnelle mensuelle : moyenne des ${historicalMonthMargins.length} dernier${historicalMonthMargins.length > 1 ? 's' : ''} mois complet${historicalMonthMargins.length > 1 ? 's' : ''} ` +
      `(${eur(projection.avgMargeHistorique)}) × coefficient d'ajustement ${coefPct} % = ${eur(projection.margePrevisionnelleMensuelle)}, appliquée identiquement à chaque mois projeté. ` +
      `Seules les charges varient mois par mois, selon les dates de fin déjà saisies.\n\n`
    );
    parts.push(mdTable(
      ['Mois', 'Marge prévisionnelle', 'Charges prévisionnelles', 'Résultat net', 'Cumulé'],
      projection.months.map(m => [m.label, eur(m.margePrevisionnelle), eur(m.chargesPrevisionnelles), eur(m.resultatNet), eur(m.cumule)]),
    ));
    parts.push(
      projection.moisSeuilDurable != null
        ? `\nPoint mort franchi de façon durable dès **${projection.months[projection.moisSeuilDurable - 1].label}** : le résultat net reste positif ou nul jusqu'à la fin de l'horizon projeté.\n`
        : `\nLe point mort n'est pas identifiable comme durablement franchi sur les ${MONTHS_AHEAD_FOR_PROJECTION} prochains mois avec ces hypothèses.\n`
    );
  }

  parts.push('\n## Limites des données\n');
  const limites: string[] = [];
  limites.push(
    produitsSansCoutCount > 0
      ? `Sur les ${produitAggs.length} produits vendus sur la période, ${produitsSansCoutCount} n'avaient pas de coût d'achat renseigné sur au moins une vente (marqués †) : leur coût et leur marge dans ce document sont sous-estimés, pas absents.`
      : `Tous les produits vendus sur la période avaient un coût d'achat renseigné.`
  );
  limites.push(
    produitsSansPumpCatalogue > 0
      ? (produitsSansPumpCatalogue > 1
          ? `${produitsSansPumpCatalogue} produits du catalogue (${products.length} au total) n'ont pas de coût d'achat moyen renseigné : la valeur de stock ci-dessus est donc elle aussi sous-évaluée d'autant.`
          : `1 produit du catalogue (${products.length} au total) n'a pas de coût d'achat moyen renseigné : la valeur de stock ci-dessus est donc elle aussi sous-évaluée d'autant.`)
      : `Tous les produits du catalogue ont un coût d'achat moyen renseigné.`
  );
  limites.push(
    historiqueJours != null
      ? `L'activité de vente a démarré le ${formatDateReunion(firstOrderDate)} (il y a ${historiqueJours} jours) : l'historique est court, les comparaisons d'une année sur l'autre ou les tendances de fond ne sont pas encore fiables.`
      : `Aucune commande enregistrée avant cette période — l'historique est très court, à interpréter avec prudence.`
  );
  limites.push(`Les ruptures de stock passées ne sont pas tracées : une vente faible sur une référence peut refléter une indisponibilité plutôt qu'un manque d'intérêt client.`);
  limites.push(`La saisonnalité locale (fêtes, période scolaire, cyclone…) n'est pas modélisée dans ces chiffres.`);
  limites.push(`Les montants de vente viennent des snapshots pris à la commande (prix, coût) : ils restent corrects même si le prix catalogue ou le coût d'achat ont changé depuis.`);
  limites.push(`Les charges de la période sont calculées au prorata du nombre de jours de chaque mois civil couvert par la période — une charge mensuelle n'est pas comptée en entier si la période ne couvre que quelques jours de son mois.`);
  if (historicalMonthMargins.length > 0 && historicalMonthMargins.length < MONTHS_HISTORY_FOR_PROJECTION) {
    limites.push(`Le prévisionnel s'appuie sur seulement ${historicalMonthMargins.length} mois complet${historicalMonthMargins.length > 1 ? 's' : ''} d'historique (activité trop récente pour ${MONTHS_HISTORY_FOR_PROJECTION}) : la moyenne qui le fonde peut ne pas être représentative — c'est une estimation à calibrer, pas un engagement.`);
  } else if (historicalMonthMargins.length >= MONTHS_HISTORY_FOR_PROJECTION) {
    limites.push(`Le prévisionnel est une estimation basée sur ${MONTHS_HISTORY_FOR_PROJECTION} mois d'historique dans une activité qui a démarré récemment — à calibrer avec prudence, pas à traiter comme un engagement.`);
  }
  limites.push(`Le coefficient d'ajustement du prévisionnel utilisé ici est ${coefPct} %${coefPct === 100 ? ' (valeur par défaut)' : ''} — ajustable sur /admin/marges.`);
  parts.push(limites.map(l => `- ${l}`).join('\n') + '\n');

  const markdown = parts.join('');
  return { markdown, sizeChars: markdown.length };
}
