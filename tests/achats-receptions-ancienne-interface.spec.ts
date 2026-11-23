/**
 * Compatibilité de la migration avec les écrans et fonctions de réception ACTUELLEMENT en production (avant le déploiement de la nouvelle interface).
 * On applique la migration, puis on rejoue, avec les mêmes appels que l'ancienne interface, ce qu'elle fait : base locale (PGlite), aucune connexion à Supabase.
 * Le seul comportement qui change est volontaire et documenté : le cumul d'une ligne de commande ne s'écrit plus à la main (CUMUL_PROTEGE).
 */
import { test, expect } from '@playwright/test';
import type { PGlite } from '@electric-sql/pglite';
import { baseAchats, un, exec, produit, commande } from './helpers/achatsBase';

const as = async (db: PGlite, role: string, q: string, p: unknown[] = []) => {
  await db.exec(`SET ROLE ${role}`);
  try { return { rows: (await db.query<any>(q, p)).rows as any[], error: '' }; }
  catch (e: any) { return { rows: [] as any[], error: String(e.message ?? e) }; }
  finally { await db.exec('RESET ROLE'); }
};
const srv = (db: PGlite, q: string, p: unknown[] = []) => as(db, 'service_role', q, p);
const stock = async (db: PGlite, p: string) => (await un(db, `SELECT stock_quantity s FROM products WHERE id = $1`, [p])).s as number;
const items = (...l: [string, number, number][]) => JSON.stringify(l.map(([product_id, quantity, unit_cost_ht]) => ({ product_id, quantity, unit_cost_ht })));

test.describe('Migration appliquée, ancienne interface encore en production', () => {
  let db: PGlite; let p1: string, p2: string, p3: string; let ouverte: { s: string; ids: string[] }; let recue: { s: string; ids: string[] }; let recHistorique: string;
  test.beforeAll(async () => {
    db = await baseAchats(true);                                                                              // la migration est DÉJÀ appliquée
    p1 = await produit(db, 'A', 0); p2 = await produit(db, 'B', 0); p3 = await produit(db, 'C', 0);
    // une commande déjà réceptionnée (cumul complet, comme MSMU6919953) dont les réceptions existent, non rattachées à la commande
    recue = await commande(db, [{ p: p1, q: 100, recu: 100 }, { p: p2, q: 50, recu: 50 }], { statut: 'receptionne', ref: 'RECUE' });
    recHistorique = (await srv(db, `SELECT reception_create('Fournisseur Test', '2026-10-20'::date, 'ancienne', true, $1::jsonb) AS id`, [items([p1, 100, 4], [p2, 50, 3])])).rows[0].id;
    ouverte = await commande(db, [{ p: p3, q: 40 }, { p: p1, q: 10 }], { statut: 'commande', ref: 'OUVERTE' });
  });
  test.afterAll(async () => { await db.close(); });

  test('réceptions « libres » (hors commande) : création, correction, suppression fonctionnent comme avant, avec le même effet sur le stock', async () => {
    const s0 = await stock(db, p3);
    const id = (await srv(db, `SELECT reception_create('Fournisseur Test', ((now() AT TIME ZONE 'UTC') + interval '4 hours')::date, 'libre', true, $1::jsonb) AS id`, [items([p3, 12, 5])])).rows[0].id;
    expect(await stock(db, p3)).toBe(s0 + 12);
    expect((await srv(db, `SELECT reception_update($1::uuid, 'Fournisseur Test', ((now() AT TIME ZONE 'UTC') + interval '4 hours')::date, 'corrigée', true, $2::jsonb)`, [id, items([p3, 20, 5])])).error).toBe('');
    expect(await stock(db, p3)).toBe(s0 + 20);
    expect((await srv(db, `SELECT reception_delete($1::uuid)`, [id])).error).toBe('');
    expect(await stock(db, p3)).toBe(s0);
  });

  test('l\'ancienne réception d\'avant la migration reste modifiable et supprimable (elle n\'est pas rattachée à une commande)', async () => {
    const avant = await stock(db, p1);
    expect((await srv(db, `SELECT reception_update($1::uuid, 'Fournisseur Test', '2026-10-20'::date, 'note corrigée', true, $2::jsonb)`, [recHistorique, items([p1, 100, 4], [p2, 50, 3])])).error).toBe('');
    expect(await stock(db, p1)).toBe(avant);                                                                  // mêmes quantités : aucun mouvement de stock
    expect((await un(db, `SELECT notes FROM stock_receptions WHERE id = $1`, [recHistorique])).notes).toBe('note corrigée');
  });

  test('commandes fournisseurs : création, modification des lignes et suppression d\'une commande NON reçue fonctionnent comme avant', async () => {
    const s = (await srv(db, `INSERT INTO shipments (supplier_name, reference, status) VALUES ('Fournisseur Test', 'NOUVELLE', 'commande') RETURNING id`)).rows[0].id;
    expect((await srv(db, `INSERT INTO shipment_items (shipment_id, product_id, quantity, unit_cost_ht) VALUES ($1, $2, 30, 5), ($1, $3, 20, 6)`, [s, p1, p2])).error).toBe('');
    // l'écran de modification supprime puis recrée les lignes
    expect((await srv(db, `DELETE FROM shipment_items WHERE shipment_id = $1`, [s])).error).toBe('');
    expect((await srv(db, `INSERT INTO shipment_items (shipment_id, product_id, quantity, unit_cost_ht) VALUES ($1, $2, 35, 5)`, [s, p1])).error).toBe('');
    expect((await srv(db, `UPDATE shipments SET status = 'en_transit' WHERE id = $1`, [s])).error).toBe('');
    expect((await srv(db, `UPDATE shipments SET status = 'dedouanement' WHERE id = $1`, [s])).error).toBe('');
    expect((await srv(db, `DELETE FROM shipment_items WHERE shipment_id = $1`, [s])).error).toBe('');
    expect((await srv(db, `DELETE FROM shipments WHERE id = $1`, [s])).error).toBe('');
    // la commande ouverte existante se modifie aussi (lignes à cumul vide)
    expect((await srv(db, `UPDATE shipment_items SET quantity = 45, unit_cost_ht = 5.5 WHERE id = $1`, [ouverte.ids[0]])).error).toBe('');
  });

  test('ajustement manuel de stock et coûts d\'approche : inchangés', async () => {
    const s0 = await stock(db, p2);
    expect((await srv(db, `SELECT product_adjust_stock($1::uuid, 5)`, [p2])).error).toBe('');
    expect(await stock(db, p2)).toBe(s0 + 5);
    expect((await srv(db, `UPDATE shipments SET notes = 'note', eta = '2026-12-01' WHERE id = $1`, [ouverte.s])).error).toBe('');
  });

  test('CE QUI CHANGE (voulu) : l\'ancien écran de réception d\'une commande n\'écrit plus le cumul à la main ; la commande déjà reçue ne peut plus être vidée ni recréée par l\'ancien écran de modification', async () => {
    // 1. l'ancienne interface créait la réception (stock +), puis écrivait le cumul séparément : cette seconde écriture est maintenant refusée
    const s0 = await stock(db, p3);
    expect((await srv(db, `SELECT reception_create('Fournisseur Test', ((now() AT TIME ZONE 'UTC') + interval '4 hours')::date, 'ancien écran', true, $1::jsonb)`, [items([p3, 10, 5])])).error).toBe('');
    expect(await stock(db, p3)).toBe(s0 + 10);                                                                // la réception « libre » a bien eu lieu, comme avant
    const maj = await srv(db, `UPDATE shipment_items SET received_quantity = 10 WHERE id = $1`, [ouverte.ids[0]]);
    expect(maj.error).toContain('CUMUL_PROTEGE');                                                             // le cumul, lui, n'est jamais écrit hors des fonctions sécurisées
    expect((await un(db, `SELECT received_quantity r FROM shipment_items WHERE id = $1`, [ouverte.ids[0]])).r).toBeNull();
    // 2. l'ancien écran de modification supprimait puis recréait toutes les lignes (remettant le cumul à zéro) : impossible sur une commande déjà reçue
    const supp = await srv(db, `DELETE FROM shipment_items WHERE shipment_id = $1`, [recue.s]);
    expect(supp.error).toContain('LIGNE_RECUE_NON_SUPPRIMABLE');
    expect((await exec(db, `SELECT received_quantity r FROM shipment_items WHERE shipment_id = $1 ORDER BY quantity`, [recue.s])).map(x => x.r)).toEqual([50, 100]);   // cumuls intacts
    expect((await srv(db, `DELETE FROM shipments WHERE id = $1`, [recue.s])).error).toContain('COMMANDE_RECUE_NON_SUPPRIMABLE');
  });
});
