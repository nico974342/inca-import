/**
 * Jeu de données « FA/1 » pour les tests : schéma de PRODUCTION (migrations de main, réceptions partielles), vrais identifiants des 16 lignes et des 6 réceptions SDR
 * relevés en lecture seule le 2026-11-23. Aucune connexion distante.
 */
import type { PGlite } from '@electric-sql/pglite';
import { baseAchats } from './achatsBase';

export const SHIP = '2f1712b0-dff2-416d-b2e1-8293061af20b';
// [ligne, produit, commandé] — relevé réel de FA/1
export const LIGNES: [string, string, number][] = [
  ['610602d3-4e16-488b-9c3d-5c497226303e', 'bafc2eca-5cbd-44bb-a595-11b73eaa0c2c', 20], ['041f8e65-cfc0-4f01-8b11-25dc75623e5e', 'd99e79a6-6b37-45ce-88e9-d406d13fb3b1', 20],
  ['f65e1d30-70c9-4ef8-82db-26bfa870106c', 'c8740f1a-5e9d-4dfa-b61c-84f2ef7e2505', 60], ['32855185-9209-49ce-8b56-97a6fa3c3588', 'ad7a7da4-f831-47c3-8c23-d61f2848c4a1', 60],
  ['6476f9a2-1030-4ae8-88a4-1c6f10667930', '708a48a1-7176-40eb-967c-6796b1593ca1', 70], ['6863aaac-918d-46ac-ac71-ae73430a4aa1', 'f103bada-3636-4614-9d0d-c3e4815fc548', 40],
  ['87bbb39b-00d2-4496-8c50-b0d7055e3ca4', 'd4059fef-b73d-4e26-a439-7aa73ef435c5', 55], ['ca931c0e-e09a-4b00-bb5c-f3c18369f039', 'a709f71d-33fb-46f5-a4aa-f055ad4bc27f', 20],
  ['ffb56ca5-5507-4aab-a4e7-1ef1548d4918', '77a3eb4d-afed-4ea1-9ef8-723d0d08c751', 25], ['06fc8d94-e9e7-42c5-99f7-9971dedd288f', 'ba5bbc20-5ce6-4a31-9fe6-cd079fc98096', 35],
  ['df150a71-cc8a-49b9-8e21-a9c773afebbf', '860c3d41-68f7-44a6-8c87-31eac0464b2f', 35], ['38466ddb-cf62-4f7d-b943-fbc7496d0ef3', 'bb9a7efc-20b4-44ce-a6fe-0be0715a9d45', 40],
  ['de9ba87c-0965-4c62-8cae-45ef6ee33c80', '2697d4c7-a01e-4958-bebe-d3134911fd5a', 40], ['53476a26-4c22-427d-9615-d910cf296aa2', 'e47c7bdc-802e-49f1-af69-6312c5b3fcff', 30],
  ['4e5e2d98-12e9-43cc-8e14-00f35dc4a1c3', '4419cba5-75f6-4869-843a-e786257471af', 20], ['e783ea08-4ac5-46fa-aecb-8a5771af39fe', '46a38a89-15b2-4b0e-94cb-42da5ab64561', 20],
];
export const TRIPLE_CHOC = { ligne: 'e783ea08-4ac5-46fa-aecb-8a5771af39fe', produit: '46a38a89-15b2-4b0e-94cb-42da5ab64561' };
export const ACTEUR = ['00000000-0000-0000-0000-0000000000a1', 'admin@inca.test', 'admin'];

/** Les six réceptions SDR du rapprochement : [id, date, stock appliqué, nombre de lignes, cartons] (relevé réel du 2026-11-23). */
export const RECEPTIONS_SDR: [string, string, boolean, number, number][] = [
  ['6d317635-4c95-45b5-a077-9aa19de1729f', '2026-06-30', false, 17, 578], ['e8d9864c-bdef-4bef-862c-68d429f8794e', '2026-08-21', true, 9, 88], ['b36b33d2-6543-4673-92ac-377376a27c0e', '2026-08-24', true, 3, 160],
  ['23863770-e0c7-428b-8643-941c04086e5a', '2026-09-04', false, 5, 88], ['24c21a2d-3376-4555-affe-263b784f7e74', '2026-09-16', true, 10, 171], ['74b9606f-575d-4824-b82d-eadd62040180', '2026-11-10', true, 8, 229],
];
export const SDR = 'a94f2fad-0642-4418-b474-fcfc9c4c6406';

export async function baseFA1(avecMigration = true): Promise<PGlite> {
  const db = await baseAchats(avecMigration);
  for (const [, p] of LIGNES) await db.query(`INSERT INTO products (id, name, price_ht, stock_quantity, tva_rate, in_stock, prix_achat_moyen_ht) VALUES ($1, $2, 10, 100, 0.085, true, 12.5)`, [p, 'P-' + p.slice(0, 4)]);
  await db.query(`INSERT INTO suppliers (id, name) VALUES ($1, 'SDR')`, [SDR]);
  await db.query(`INSERT INTO shipments (id, supplier_name, supplier_id, reference, status) VALUES ($1, 'SDR', $2, 'FA/1', 'commande')`, [SHIP, SDR]);
  // Réceptions SDR de la production : stock DÉJÀ compté (on insère les lignes sans toucher au stock des produits de test), mêmes totaux et mêmes nombres de lignes que le relevé
  for (const [id, date, appliquee, nb, total] of RECEPTIONS_SDR) {
    await db.query(`INSERT INTO stock_receptions (id, supplier_name, supplier_id, received_at, notes, stock_applied) VALUES ($1, 'SDR', $2, $3::date, 'relevé', $4)`, [id, SDR, date, appliquee]);
    for (let i = 0; i < nb; i++) await db.query(`INSERT INTO stock_reception_items (reception_id, product_id, quantity, unit_cost_ht) VALUES ($1, $2, $3, 10)`, [id, LIGNES[i % LIGNES.length][1], i === 0 ? total - (nb - 1) : 1]);
  }
  for (const [l, p, q] of LIGNES) await db.query(`INSERT INTO shipment_items (id, shipment_id, product_id, quantity, unit_cost_ht) VALUES ($1, $2, $3, $4, 17)`, [l, SHIP, p, q]);
  return db;
}
