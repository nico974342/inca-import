// Vérifications ciblées du moteur de /admin/commande-fournisseur, sur les
// scénarios métier donnés dans la demande. Exécuter avec :
//   npx tsx scripts/test-commande-fournisseur.ts
// Pas de dépendance DB : ce script n'exerce que les fonctions pures de
// src/lib/constants.ts — c'est délibéré, ce sont elles qui portent toute la
// logique de décision (voir "Centralise les calculs partagés").

import {
  resolveDelaiLivraison, classifyReorder, stockAtReceipt, computeReorderQtyForTarget,
  computeReorderQtyWithBridge,
  applyMoqAndMultiple, engagementNonCouvert, projectStock, computeAdjustedVitesse,
  addDays,
  type ArrivalEvent,
} from '../src/lib/constants.ts';

let pass = 0, fail = 0;
function assert(cond: boolean, label: string, detail?: string) {
  if (cond) { pass++; console.log(`  ✓ ${label}`); }
  else { fail++; console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
}
function approx(a: number, b: number, eps = 0.5): boolean {
  return Math.abs(a - b) <= eps;
}

// ── Scénario 1 : produit sans exception de délai, fournisseur à 60 jours ──
console.log('\nScénario 1 — délai fournisseur utilisé sans exception produit');
{
  // Un produit qui porte encore un reliquat de l'ancien défaut (21 j), mais
  // dont l'override n'a jamais été confirmé : ne doit JAMAIS l'emporter sur
  // le fournisseur.
  const r = resolveDelaiLivraison(21, false, 'SDR', 60);
  assert(r.jours === 60 && r.source === 'fournisseur', 'délai = 60 j, source = fournisseur', JSON.stringify(r));

  // Sans aucune valeur produit du tout, même résultat.
  const r2 = resolveDelaiLivraison(null, false, 'SDR', 60);
  assert(r2.jours === 60 && r2.source === 'fournisseur', 'délai = 60 j sans valeur produit', JSON.stringify(r2));

  // Une exception produit EXPLICITEMENT activée doit, elle, l'emporter.
  const r3 = resolveDelaiLivraison(45, true, 'SDR', 60);
  assert(r3.jours === 45 && r3.source === 'produit_override', 'exception produit confirmée prioritaire', JSON.stringify(r3));
}

// ── Scénario 2 : 100 cartons, 10/semaine, aucun arrivage ──
console.log('\nScénario 2 — jours avant commande, sans arrivage');
{
  const vq = 10 / 7; // cartons/jour
  const a = classifyReorder(100, vq, 10, 5, []);
  assert(a.primary === 'a_prevoir', `délai 10j/sécurité 5j → a_prevoir (obtenu: ${a.primary})`);
  assert(a.joursAvantCommande != null && approx(a.joursAvantCommande, 55, 1), `≈55 jours (obtenu: ${a.joursAvantCommande})`);

  const b = classifyReorder(100, vq, 60, 10, []);
  assert(b.primary === 'commander_maintenant', `délai 60j/sécurité 10j → commander_maintenant (obtenu: ${b.primary})`);
  assert(b.joursAvantCommande != null && approx(b.joursAvantCommande, 0, 1), `≈0 jour (obtenu: ${b.joursAvantCommande})`);
}

// ── Scénario 3 : arrivage ferme, sizing si commande passée AUJOURD'HUI ──
// Convention (confirmée) : couverture cible = ventes normales ; sécurité =
// réserve ADDITIONNELLE. Stock visé après réception = vente×(couverture+sécurité).
console.log('\nScénario 3 — arrivage ferme à J+7, sizing pour une commande passée aujourd’hui');
{
  const vq = 14 / 7; // = 2 cartons/jour
  const disponible = 40;
  const arrivals: ArrivalEvent[] = [{ shipmentId: 's1', quantity: 60, eta: new Date(Date.now() + 7 * 86_400_000), status: 'en_transit' }];

  const points = projectStock(disponible, vq, arrivals, 28);
  const noIntermediateRupture = points.slice(0, 8).every(p => p.stock > 0); // jours 0..7 inclus
  assert(noIntermediateRupture, 'aucune rupture entre aujourd’hui et l’arrivage (J+7)',
    JSON.stringify(points.slice(0, 8).map(p => Math.round(p.stock))));

  const receipt = stockAtReceipt(disponible, vq, 28, arrivals); // réception de la NOUVELLE commande à J+28
  assert(approx(receipt, 44, 0.01), `stock prévu juste avant réception = 44 (obtenu: ${receipt})`,
    '40 + 60 (arrivage J+7) - 56 (28j x 2/j) = 44');

  const qty = computeReorderQtyForTarget(vq, receipt, 28, 7);
  assert(qty === 26, `quantité = 26 (obtenu: ${qty})`, 'cible 28x2+7x2=70, besoin 70-44=26');
}

// ── Moment ≠ quantité : le scénario 3 ne force pas "commander maintenant" ──
console.log('\nScénario 2bis — le dimensionnement du scénario 3 ne dicte pas le déclenchement');
{
  const vq = 14 / 7;
  const arrivals: ArrivalEvent[] = [{ shipmentId: 's1', quantity: 60, eta: addDays(new Date(), 7), status: 'en_transit' }];
  const trigger = classifyReorder(40, vq, 28, 7, arrivals);
  assert(trigger.primary === 'a_prevoir', `déclenchement = a_prevoir, pas une urgence (obtenu: ${trigger.primary})`);
  assert(trigger.joursAvantCommande != null && approx(trigger.joursAvantCommande, 15, 1),
    `date conseillée environ J+15 (obtenu: ${trigger.joursAvantCommande})`,
    'couverture totale (disponible+arrivage)/vente = 100/2 = 50j ; 50-28-7=15');

  // Composition : si on attend le jour conseillé (J+15) et que les
  // hypothèses restent constantes, la NOUVELLE évaluation à ce moment-là
  // donne une quantité différente de celle calculée "si commandé
  // aujourd'hui" (26) — moment et quantité restent deux calculs séparés,
  // rejoués l'un après l'autre, jamais une seule formule figée à J+0.
  const waitDays = Math.round(trigger.joursAvantCommande!);
  const dayOfOrder = addDays(new Date(), waitDays);
  const disponibleAtWait = 40 - waitDays * vq + 60; // l'arrivage J+7 est déjà passé et intégré au disponible constaté
  assert(approx(disponibleAtWait, 70, 0.01), `disponible constaté à J+15 = 70 (obtenu: ${disponibleAtWait})`);

  const receiptAtWait = stockAtReceipt(disponibleAtWait, vq, 28, [], dayOfOrder);
  assert(approx(receiptAtWait, 14, 0.01), `stock prévu à la réception si commandé à J+15 = 14 (obtenu: ${receiptAtWait})`,
    '70 - 28x2 = 14');
  const qtyAtWait = computeReorderQtyForTarget(vq, receiptAtWait, 28, 7);
  assert(qtyAtWait === 56, `quantité si commandé à J+15 = 56, distincte des 26 de J+0 (obtenu: ${qtyAtWait})`,
    'cible 70, stock prévu 14, besoin 70-14=56');
}

// ── Scénario 4 : arrivage tardif ne masque pas une rupture antérieure ──
console.log('\nScénario 4 — un arrivage tardif laisse subsister l’alerte de rupture');
{
  const vq = 10 / 7; // ≈1.43 cartons/jour, stock tient 7 jours pour 10 cartons
  const arrivals: ArrivalEvent[] = [{ shipmentId: 's2', quantity: 100, eta: new Date(Date.now() + 20 * 86_400_000), status: 'commande' }];
  const withArrival = classifyReorder(10, vq, 10, 0, arrivals);
  const withoutArrival = classifyReorder(10, vq, 10, 0, []);
  assert(withArrival.primary === 'rupture_avant_commande_normale',
    `rupture toujours signalée malgré l’arrivage à J+20 (obtenu: ${withArrival.primary})`);
  assert(withArrival.primary === withoutArrival.primary,
    'même verdict avec ou sans l’arrivage tardif — il ne masque rien', `avec=${withArrival.primary} sans=${withoutArrival.primary}`);
}

// ── Scénario 4bis : la réserve de sécurité peut être entamée AVANT un
//    arrivage qui repousse pourtant la rupture réelle très loin. ──
console.log('\nScénario 4bis — réserve de sécurité entamée entre aujourd’hui et un arrivage');
{
  const disponible = 20, vq = 2, delai = 5, securite = 5; // sécurité = 5j x 2/j = 10 cartons
  const arrivals: ArrivalEvent[] = [{ shipmentId: 's3', quantity: 100, eta: addDays(new Date(), 8), status: 'commande' }];

  const trigger = classifyReorder(disponible, vq, delai, securite, arrivals);
  assert(trigger.primary !== 'rupture_avant_commande_normale',
    `pas confondu avec une rupture certaine (obtenu: ${trigger.primary})`, JSON.stringify(trigger));
  assert(trigger.primary === 'commander_maintenant',
    `commande conseillée maintenant (obtenu: ${trigger.primary})`,
    'stock descend à 10 (= réserve voulue) dès J+5, soit exactement au jour où une commande normale arriverait');
  assert(trigger.margeInsuffisante === true,
    'signalé comme réserve de sécurité insuffisante (pas juste "à prévoir")', JSON.stringify(trigger));
  assert(trigger.joursAvantCommande != null && approx(trigger.joursAvantCommande, 0, 0.5),
    `jours avant commande ≈ 0 (obtenu: ${trigger.joursAvantCommande})`);

  // La rupture RÉELLE (stock à zéro), elle, n'arrive que vers J+60 — loin
  // derrière l'alerte de sécurité déclenchée à J+5. Les deux ne doivent
  // jamais être confondues : ce test vérifie qu'elles restent distinctes.
  const noSecurity = classifyReorder(disponible, vq, delai, 0, arrivals);
  assert(noSecurity.primary === 'a_prevoir' && noSecurity.joursAvantCommande != null && approx(noSecurity.joursAvantCommande, 55, 1),
    `sans sécurité, la rupture réelle projetée reste à ≈J+55-60 (obtenu: ${noSecurity.primary}/${noSecurity.joursAvantCommande})`,
    'stock à 0 vers J+60 (104 cartons à J+8, déclinant de 2/j) ; 60-5=55');

  // La taille de commande, elle, ne doit pas se laisser aveugler par le gros
  // arrivage de J+8 : une commande déclenchée aujourd'hui arrive à J+5,
  // AVANT J+8 — le stock prévu à cette réception ne doit donc PAS inclure
  // les 100 cartons qui n'ont pas encore atterri.
  const receipt = stockAtReceipt(disponible, vq, delai, arrivals);
  assert(approx(receipt, 10, 0.01), `stock prévu à réception (J+5, avant l’arrivage J+8) = 10, pas 110 (obtenu: ${receipt})`,
    '20 - 5x2 = 10 ; le gros arrivage de J+8 n’est pas encore là');

  // Dimensionnement complet : ni 60 (cible pleine à J+5, ignore l’arrivage
  // qui suit de 3 jours), ni 0 (soustraction globale des 100, ignore le
  // creux de sécurité avant qu’ils n’arrivent) — seulement de quoi tenir la
  // réserve jusqu’à J+8, l’arrivage faisant le reste.
  const qty = computeReorderQtyWithBridge(disponible, vq, delai, /* couverture */ 30, securite, arrivals);
  assert(qty === 6, `dimensionnement = 6, ni 60 ni 0 (obtenu: ${qty})`,
    'stock juste avant l’arrivage de J+8 (après consommation du jour) = 4 ; réserve visée 10 ; besoin 10-4=6');
}

// ── Scénario 4ter : table complète — le dimensionnement traite TOUS les
//    arrivages sur la période de couverture, pas seulement le cas où l'un
//    d'eux suffit seul à couvrir la cible. Mêmes données que 4bis (20
//    dispo, 2/j, délai 5j, couverture 30j → jusqu'à J+35, sécurité 5j = 10
//    cartons), arrivages différents. ──
console.log('\nScénario 4ter — le dimensionnement couvre tous les arrivages de la période, pas juste le premier assez gros');
{
  const disponible = 20, vq = 2, delai = 5, couverture = 30, securite = 5;

  const cas: [string, ArrivalEvent[], number, string][] = [
    ['100 à J+8', [
      { shipmentId: 'a', quantity: 100, eta: addDays(new Date(), 8), status: 'commande' },
    ], 6, 'creux avant J+8 (4) → 10-4=6 ; l’arrivage seul couvre largement le reste de la fenêtre'],

    ['30 à J+8 (trop petit pour couvrir seul)', [
      { shipmentId: 'a', quantity: 30, eta: addDays(new Date(), 8), status: 'commande' },
    ], 30, '30 ne suffit pas à tenir jusqu’à J+35 : le creux le plus bas de la fenêtre tombe en fin de période (J+35), pas juste avant J+8'],

    ['30 à J+8 puis 20 à J+20', [
      { shipmentId: 'a', quantity: 30, eta: addDays(new Date(), 8), status: 'commande' },
      { shipmentId: 'b', quantity: 20, eta: addDays(new Date(), 20), status: 'commande' },
    ], 10, 'deux arrivages partiels combinés : le creux le plus bas tombe à la toute fin de la fenêtre (J+35), après les deux'],

    ['100 à J+36 (hors de la fenêtre de couverture)', [
      { shipmentId: 'a', quantity: 100, eta: addDays(new Date(), 36), status: 'commande' },
    ], 60, 'un arrivage après J+35 ne compte pas pour CETTE commande — se réduit à la formule simple (cible − stock à réception)'],
  ];

  for (const [label, arrivals, expected, detail] of cas) {
    const got = computeReorderQtyWithBridge(disponible, vq, delai, couverture, securite, arrivals);
    assert(got === expected, `${label} → ${expected} (obtenu: ${got})`, detail);
  }

  // Arrivages simultanés : deux lignes le même jour doivent se cumuler
  // exactement comme une seule ligne de la somme des deux.
  const separes = computeReorderQtyWithBridge(disponible, vq, delai, couverture, securite, [
    { shipmentId: 'a', quantity: 20, eta: addDays(new Date(), 8), status: 'commande' },
    { shipmentId: 'b', quantity: 15, eta: addDays(new Date(), 8), status: 'commande' },
  ]);
  const groupes = computeReorderQtyWithBridge(disponible, vq, delai, couverture, securite, [
    { shipmentId: 'c', quantity: 35, eta: addDays(new Date(), 8), status: 'commande' },
  ]);
  assert(separes === groupes, `arrivages simultanés cumulés correctement (20+15=${separes} == 35=${groupes})`);
}

// ── Scénario 5 : marge insuffisante ≠ rupture avant livraison ──
console.log('\nScénario 5 — marge de sécurité insuffisante, distincte de la rupture avant livraison');
{
  const vq = 1; // 18 jours de stock à 1 carton/jour = 18 cartons dispo
  const r = classifyReorder(18, vq, 14, 7, []);
  assert(r.primary !== 'rupture_avant_commande_normale', `pas classé "rupture avant livraison" (obtenu: ${r.primary})`, JSON.stringify(r));
  assert(r.margeInsuffisante === true, 'marge de sécurité insuffisante détectée', JSON.stringify(r));
}

// ── Reconstruction des ruptures : correction raisonnable vs garde-fou ──
console.log('\nReconstruction de rupture — correction appliquée vs écartée par prudence');
{
  // Rupture modérée : vendable 6 des 10 semaines (60 %) — correction dans le
  // ratio autorisé (×3 max), appliquée.
  const modere = computeAdjustedVitesse(/* qtySold */ 30, /* rawWeeks */ 10, /* sellableDays */ 42, /* stockoutDetected */ true);
  assert(modere.reconstructionApplied === true, 'rupture modérée → correction appliquée', JSON.stringify(modere));
  assert(!modere.reconstructionUncertain, 'pas signalée incertaine dans ce cas', JSON.stringify(modere));
  assert(approx(modere.vitesse, 5, 0.1), `vitesse corrigée ≈ 5/sem (obtenu: ${modere.vitesse.toFixed(2)})`, '30 vendus / 6 sem vendables');

  // Rupture quasi totale : vendable 3 jours sur 70 (≈4 %) — sous le seuil de
  // 20 %, la correction est jugée peu fiable (plus probablement un trou de
  // données) et écartée au profit de la vitesse brute.
  const extreme = computeAdjustedVitesse(/* qtySold */ 30, /* rawWeeks */ 10, /* sellableDays */ 3, /* stockoutDetected */ true);
  assert(extreme.reconstructionApplied === false, 'rupture quasi totale → correction écartée', JSON.stringify(extreme));
  assert(extreme.reconstructionUncertain === true, 'signalée incertaine (garde-fou déclenché)', JSON.stringify(extreme));
  assert(approx(extreme.vitesse, 3, 0.1), `repli sur la vitesse brute ≈ 3/sem (obtenu: ${extreme.vitesse.toFixed(2)})`, '30 vendus / 10 sem calendaires');

  // Pas de rupture détectée : vitesse brute telle quelle, aucun drapeau.
  const aucune = computeAdjustedVitesse(30, 10, 70, false);
  assert(aucune.reconstructionApplied === false && aucune.reconstructionUncertain === false,
    'sans rupture détectée, ni correction ni incertitude signalées', JSON.stringify(aucune));
}

// ── Contrôles complémentaires : MOQ/multiple, engagement non couvert ──
console.log('\nContrôles complémentaires');
{
  assert(applyMoqAndMultiple(7, 10, null) === 10, 'minimum de commande respecté (7 → 10)');
  assert(applyMoqAndMultiple(7, null, 5) === 10, 'multiple de commande respecté (7 → 10)');
  assert(applyMoqAndMultiple(0, 10, 5) === 0, 'un besoin nul reste nul malgré un minimum');
  assert(applyMoqAndMultiple(11, 10, 5) === 15, 'minimum ET multiple respectés ensemble (11 → 15)');

  assert(engagementNonCouvert(20 - 30) === 10, '20 physiques / 30 réservés → manque de 10 cartons signalé');
  assert(engagementNonCouvert(5) === 0, 'disponible positif → aucun manque signalé');
}

console.log(`\n${pass} succès, ${fail} échec${fail === 1 ? '' : 's'}.`);
process.exit(fail > 0 ? 1 : 0);
