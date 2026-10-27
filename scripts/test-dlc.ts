// Vérifications de la logique DLC (src/lib/dlc.ts) — fonctions pures, sans base.
// Exécuter avec :  npx tsx scripts/test-dlc.ts

import { analyzeLots, addMonthsISO, type LotInput } from '../src/lib/dlc.ts';

let pass = 0, fail = 0;
function assert(cond: boolean, label: string, detail?: string) {
  if (cond) { pass++; console.log(`  ✓ ${label}`); }
  else { fail++; console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
}

const TODAY = '2026-10-27';
const lot = (id: string, receivedAt: string, quantity: number, dlc: string | null): LotInput =>
  ({ id, receptionId: 'r-' + id, receivedAt, createdAt: receivedAt + 'T10:00:00Z', quantity, dlc });

console.log('\nFIFO : le stock actuel est composé des lots les plus récents');
{
  const a = analyzeLots([lot('juin', '2026-06-10', 100, '2026-12-01'), lot('oct', '2026-10-05', 60, '2027-04-01')], 80, 0, 7, TODAY);
  const juin = a.lots.find(l => l.lotId === 'juin');
  const oct = a.lots.find(l => l.lotId === 'oct');
  assert(oct?.qtyRemaining === 60, 'lot d\'octobre entièrement en stock (60)');
  assert(juin?.qtyRemaining === 20, 'lot de juin : il en reste 20 (80 − 60)');
  assert(a.stockHorsLots === 0, 'aucun stock hors lots');
}

console.log('\nLot qui s\'écoule à temps → OK');
{
  // 14 cartons/semaine = 2/j ; 40 cartons ; DLC dans 60 jours → 20 jours pour tout vendre
  const a = analyzeLots([lot('a', '2026-10-01', 40, '2026-12-26')], 40, 0, 14, TODAY);
  const l = a.lots[0];
  assert(l.daysLeft === 60, 'jours restants = 60', String(l.daysLeft));
  assert(l.level === 'ok' && l.unsold === 0, 'niveau ok, rien d\'invendu', `${l.level} ${l.unsold}`);
  assert(Math.abs((l.daysToClear ?? 0) - 20) < 1e-9, 'temps pour écouler = 20 j', String(l.daysToClear));
}

console.log('\nLot à risque : le temps d\'écoulement dépasse les jours restants');
{
  // 2/j ; 200 cartons ; DLC dans 60 j → 120 vendables, 80 invendus
  const a = analyzeLots([lot('a', '2026-10-01', 200, '2026-12-26')], 200, 0, 14, TODAY);
  const l = a.lots[0];
  assert(l.level === 'a_risque', 'niveau à risque', l.level);
  assert(l.unsold === 80, '80 cartons invendus estimés', String(l.unsold));
  assert(Math.abs((l.daysToClear ?? 0) - 100) < 1e-9, '100 j nécessaires > 60 j restants', String(l.daysToClear));
}

console.log('\nCritique : moins de 30 jours, même si tout peut s\'écouler');
{
  const a = analyzeLots([lot('a', '2026-10-01', 10, '2026-11-10')], 10, 0, 14, TODAY);
  const l = a.lots[0];
  assert(l.daysLeft === 14 && l.level === 'critique', 'critique à 14 j', `${l.daysLeft} ${l.level}`);
  assert(l.unsold === 0, 'mais rien d\'invendu estimé (10 cartons, 28 vendables)', String(l.unsold));
  const edge = analyzeLots([lot('b', '2026-10-01', 10, '2026-11-26')], 10, 0, 14, TODAY).lots[0];
  assert(edge.daysLeft === 30 && edge.level === 'ok', '30 j pile n\'est pas critique', `${edge.daysLeft} ${edge.level}`);
  const edge2 = analyzeLots([lot('c', '2026-10-01', 10, '2026-11-25')], 10, 0, 14, TODAY).lots[0];
  assert(edge2.daysLeft === 29 && edge2.level === 'critique', '29 j est critique');
}

console.log('\nPérimé : date passée');
{
  const a = analyzeLots([lot('a', '2026-05-01', 30, '2026-10-26')], 30, 0, 14, TODAY);
  const l = a.lots[0];
  assert(l.level === 'perime' && l.daysLeft === -1, 'périmé hier', `${l.level} ${l.daysLeft}`);
  assert(l.unsold === 30, 'tout le lot est invendable (30)');
  const today = analyzeLots([lot('b', '2026-05-01', 30, TODAY)], 30, 0, 14, TODAY).lots[0];
  assert(today.level === 'critique' && today.daysLeft === 0, 'DLC aujourd\'hui : pas encore périmé (dernier jour)');
}

console.log('\nHonnêteté : pas de vitesse → « non estimable », jamais « à risque »');
{
  const far = analyzeLots([lot('a', '2026-10-01', 500, '2027-03-01')], 500, 0, null, TODAY).lots[0];
  assert(far.level === 'non_estimable', 'non estimable (DLC lointaine, aucune vente)', far.level);
  assert(far.unsold === null && far.daysToClear === null, 'aucune quantité invendue annoncée');
  const near = analyzeLots([lot('b', '2026-10-01', 50, '2026-11-10')], 50, 0, null, TODAY).lots[0];
  assert(near.level === 'critique' && near.unsold === null, 'DLC proche reste critique (calendrier), invendu non estimé');
  const zero = analyzeLots([lot('c', '2026-10-01', 50, '2027-03-01')], 50, 0, 0, TODAY).lots[0];
  assert(zero.level === 'non_estimable', 'vitesse 0 traitée comme non estimable');
}

console.log('\nHonnêteté : lot sans DLC = « non renseigné », pas « ok »');
{
  const a = analyzeLots([lot('a', '2026-10-01', 40, null)], 40, 0, 14, TODAY);
  assert(a.lots[0].level === 'non_renseigne' && a.lots[0].daysLeft === null, 'non renseigné');
}

console.log('\nFIFO : les lots plus anciens passent devant');
{
  // 2/j. Lot ancien 100 (DLC J+200), lot récent 100 (DLC J+60). Stock 200.
  // Le récent n'est vendable qu'après l'ancien : devant lui 100 cartons → 50 j perdus ;
  // en 60 j on vend 120 au total : 100 (ancien) puis 20 du récent → 80 invendus.
  const a = analyzeLots([lot('ancien', '2026-08-01', 100, '2027-05-15'), lot('recent', '2026-10-01', 100, '2026-12-26')], 200, 0, 14, TODAY);
  const r = a.lots.find(l => l.lotId === 'recent')!;
  assert(r.unsold === 80, 'lot récent : 80 invendus à cause du lot ancien devant', String(r.unsold));
  assert(Math.abs((r.daysToClear ?? 0) - 100) < 1e-9, 'écoulement du récent = (100+100)/2 = 100 j');
}

console.log('\nRéservations : elles partent en premier, FIFO');
{
  // Même cas, mais 100 cartons déjà réservés : ils sortent de l'ancien lot → le récent passe devant.
  const a = analyzeLots([lot('ancien', '2026-08-01', 100, '2027-05-15'), lot('recent', '2026-10-01', 100, '2026-12-26')], 200, 100, 14, TODAY);
  const r = a.lots.find(l => l.lotId === 'recent')!;
  assert(r.qtyRemaining === 100, 'quantité physique affichée inchangée (100)');
  assert(r.unsold === 0, 'plus rien d\'invendu : les 100 réservés ont vidé l\'ancien lot (120 vendables ≥ 100)', String(r.unsold));
}

console.log('\nStock au-delà des lots (stock initial saisi à la main)');
{
  const a = analyzeLots([lot('a', '2026-10-01', 30, '2027-01-01')], 100, 0, 14, TODAY);
  assert(a.stockHorsLots === 70, '70 cartons hors lots', String(a.stockHorsLots));
  // ces 70 cartons sont devant : 70/2 = 35 j perdus ; 66 j restants → 2*66-70 = 62 vendables ≥ 30
  assert(a.lots[0].level === 'ok' && a.lots[0].daysToClear === 50, 'ils comptent devant le lot (100/2 = 50 j)', `${a.lots[0].level} ${a.lots[0].daysToClear}`);
}

console.log('\nLots épuisés ignorés, stock nul');
{
  const a = analyzeLots([lot('a', '2026-06-01', 50, '2026-09-01')], 0, 0, 14, TODAY);
  assert(a.lots.length === 0, 'stock 0 → aucun lot à surveiller (même périmé)');
}

console.log('\nCalcul de date (pré-remplissage)');
{
  assert(addMonthsISO('2026-10-27', 12) === '2027-10-27', '+12 mois');
  assert(addMonthsISO('2026-01-31', 1) === '2026-02-28', '31 janv. + 1 mois = 28 févr.');
  assert(addMonthsISO('2027-12-15', 2) === '2028-02-15', 'passage d\'année');
  assert(addMonthsISO('2027-01-31', 1) === '2027-02-28', 'année non bissextile');
  assert(addMonthsISO('2028-01-31', 1) === '2028-02-29', 'année bissextile');
}

console.log(`\n${pass} succès, ${fail} échec${fail === 1 ? '' : 's'}.`);
process.exit(fail ? 1 : 0);
