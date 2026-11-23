/**
 * Commande « FA/1 » (réceptionnée en partie par l'ancien système AVANT la migration) : méthode de rattachement du CUMUL SANS mouvement de stock.
 * Base locale PGlite reproduisant la FORME de FA/1 (réceptions libres, stock déjà compté, cumul NULL). Aucune connexion, aucune écriture en production.
 * La régularisation réelle n'est PAS exécutée : elle exige la validation du rapprochement (docs/achats-fa1-rapprochement.md) et l'accord explicite.
 */
import { test, expect } from '@playwright/test';
import { baseAchats, MIGRATION, un } from './helpers/achatsBase';

const ACTEUR = ['00000000-0000-0000-0000-0000000000a1', 'admin@inca.test', 'admin'];

test('rattachement du cumul seul : aucun mouvement de stock ; la ligne soldée refuse tout nouvel apport (pas de double entrée) ; le reste exact est accepté', async () => {
  const db = await baseAchats(false);
  const P = async (n: string) => (await un(db, `INSERT INTO products (name, price_ht, stock_quantity, tva_rate, in_stock) VALUES ($1,10,0,0.085,true) RETURNING id`, [n])).id as string;
  const choc = await P('Chocolat'), triple = await P('Triple');
  const s = (await un(db, `INSERT INTO shipments (supplier_name, reference, status) VALUES ('SDR','FA/1','commande') RETURNING id`)).id as string;
  const I = async (p: string, q: number) => (await un(db, `INSERT INTO shipment_items (shipment_id, product_id, quantity, unit_cost_ht) VALUES ($1,$2,$3,17) RETURNING id`, [s, p, q])).id as string;
  const iChoc = await I(choc, 70), iTri = await I(triple, 20);
  const libre = (d: string, items: unknown[]) => un(db, `SELECT reception_create('SDR',$1::date,'x',true,$2::jsonb) id`, [d, JSON.stringify(items)]);
  await libre('2026-09-16', [{ product_id: choc, quantity: 8, unit_cost_ht: 17 }, { product_id: triple, quantity: 5, unit_cost_ht: 12.9 }]);
  await libre('2026-11-10', [{ product_id: choc, quantity: 62, unit_cost_ht: 16.4 }, { product_id: triple, quantity: 8, unit_cost_ht: 12.9 }]);
  await db.exec(MIGRATION);
  const stock = async (p: string) => Number((await un(db, `SELECT stock_quantity q FROM products WHERE id=$1`, [p])).q);
  expect([await stock(choc), await stock(triple)]).toEqual([70, 13]);
  const avant = (await un(db, `SELECT shipment_reception_etat($1) e`, [s])).e; expect(avant.statut).toBe('attente'); expect(avant.cumul).toBe(0);      // le risque : « 0 reçu » alors que 83 sont en stock

  // sans le drapeau d'écriture : la base refuse
  await expect(db.query(`UPDATE shipment_items SET received_quantity = 70 WHERE id=$1`, [iChoc])).rejects.toThrow(/CUMUL_PROTEGE/);

  await db.exec(`BEGIN; SELECT set_config('inca.achats_ecriture','1',true)`);
  await db.query(`UPDATE shipment_items SET received_quantity = 70 WHERE id=$1`, [iChoc]); await db.query(`UPDATE shipment_items SET received_quantity = 13 WHERE id=$1`, [iTri]);
  await db.query(`INSERT INTO admin_audit_logs (admin_email, action, target_type, target_id, target_label, details) VALUES ($1,'reception.regularisation_cumul','shipment',$2,'FA/1','{}'::jsonb)`, [ACTEUR[1], s]);
  await db.exec(`SELECT set_config('inca.achats_ecriture','',true); COMMIT`);

  expect([await stock(choc), await stock(triple)]).toEqual([70, 13]);                                  // aucun mouvement de stock
  const apres = (await un(db, `SELECT shipment_reception_etat($1) e`, [s])).e; expect(apres).toMatchObject({ recu: 83, reste: 7, statut: 'partielle' });
  const enr = (q: number, ligne: string) => un(db, `SELECT reception_commande_enregistrer($1,$2,'2026-11-20'::date,'BL',NULL,$3::jsonb,$4,$5,$6) r`, [crypto.randomUUID(), s, JSON.stringify([{ shipment_item_id: ligne, quantity: q, unit_cost_ht: 12.9 }]), ...ACTEUR]);
  await expect(enr(1, iChoc)).rejects.toThrow(/DEPASSEMENT_COMMANDE/);                                 // ligne soldée : pas de double entrée
  await expect(enr(8, iTri)).rejects.toThrow(/DEPASSEMENT_COMMANDE/);
  await enr(7, iTri); expect(await stock(triple)).toBe(20); expect(await stock(choc)).toBe(70);
  // le rattachement des RÉCEPTIONS elles-mêmes (méthode B) est refusé par la migration validée, même avec le drapeau : il exigerait une 2e migration additive
  await db.exec(`BEGIN; SELECT set_config('inca.achats_ecriture','1',true)`);
  const id = (await un(db, `SELECT id FROM stock_receptions WHERE shipment_id IS NULL LIMIT 1`)).id;
  await expect(db.query(`UPDATE stock_receptions SET shipment_id=$1, cle_idempotence=gen_random_uuid(), created_by=$2, created_by_email='a@x', empreinte='x' WHERE id=$3`, [s, ACTEUR[0], id])).rejects.toThrow(/RECEPTION_IMMUABLE/);
  await db.exec(`ROLLBACK`);
});
