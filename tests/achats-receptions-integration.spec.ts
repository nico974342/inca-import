/**
 * Réceptions PARTIELLES × stock × CUMP — intégration sur le schéma de PRODUCTION complet.
 * Base locale PGlite (vrai PostgreSQL) : toutes les migrations de main déjà appliquées en production (correctif des stocks de réception, moteur CUMP v1, méthode v2, recalcul
 * automatique, interrupteur ACTIF), PUIS achats_receptions_partielles.sql. Aucune connexion distante, aucune écriture en production.
 * Les accès réellement simultanés sont testés par supabase/controles/concurrence_achats.mjs (PostgreSQL local jetable).
 *
 * Risques visés : double réception (stock compté deux fois), stock artificiel (stock recréé ou retiré à tort), mauvais calcul des marges (CUMP / PUMP), réceptions existantes.
 */
import { test, expect } from '@playwright/test';
import type { PGlite } from '@electric-sql/pglite';
import { baseAchats, un, exec, produit, commande } from './helpers/achatsBase';

const ACTEUR = ['00000000-0000-0000-0000-0000000000a1', 'admin@inca.test', 'admin'];
const aujourdhui = () => new Date(Date.now() + 4 * 3600_000).toISOString().slice(0, 10);
const cle = () => crypto.randomUUID();
const enregistrer = (db: PGlite, k: string, s: string, date: string, items: { shipment_item_id: string; quantity: number; unit_cost_ht: number }[], bl = 'BL1') =>
  un(db, `SELECT reception_commande_enregistrer($1,$2,$3::date,$4,NULL,$5::jsonb,$6,$7,$8) r`, [k, s, date, bl, JSON.stringify(items), ...ACTEUR]).then(x => x.r);
const annuler = (db: PGlite, rec: string, motif = 'erreur de saisie') => un(db, `SELECT reception_commande_annuler($1,$2,$3,$4,$5) r`, [rec, motif, ...ACTEUR]).then(x => x.r);
const stock = async (db: PGlite, p: string) => Number((await un(db, `SELECT stock_quantity q FROM products WHERE id=$1`, [p])).q);
const pump = async (db: PGlite, p: string) => Number((await un(db, `SELECT prix_achat_moyen_ht v FROM products WHERE id=$1`, [p])).v);
const enAttente = async (db: PGlite) => Number((await un(db, `SELECT count(*) n FROM cump_file WHERE statut = 'en_attente'`)).n);
const traiter = (db: PGlite) => un(db, `SELECT cump_traiter_file() r`).then(x => x.r);
const refus = async (f: () => Promise<unknown>) => { try { await f(); return null; } catch (e: any) { return String(e.message); } };
/** Livraison réelle d'une commande client : déduction par order_mark_livree (fonction réelle) + trace de la date au journal, comme la page des commandes. */
async function livrer(db: PGlite, p: string, qty: number, cree: string, livre: string) {
  const snap = (await un(db, `SELECT prix_achat_moyen_ht s FROM products WHERE id=$1`, [p])).s;
  const cmd = (await un(db, `INSERT INTO orders (status, created_at) VALUES ('en_attente', $1::timestamptz) RETURNING id`, [cree])).id as string;
  const it = (await un(db, `INSERT INTO order_items (order_id, product_id, product_name, quantity, price_ht_snapshot, pump_snapshot) VALUES ($1,$2,'x',$3,20,$4) RETURNING id`, [cmd, p, qty, snap])).id as string;
  await db.query(`UPDATE orders SET status='livree' WHERE id=$1`, [cmd]); await db.query(`SELECT * FROM order_mark_livree($1)`, [cmd]);
  await db.query(`INSERT INTO admin_audit_logs (admin_email, action, target_type, target_id, details, created_at) VALUES ('a@x.local','commande.statut','order',$1,'{"ancien":"en_attente","nouveau":"livree"}'::jsonb,$2::timestamptz)`, [cmd, livre]);
  return { cmd, it };
}
const coutCump = async (db: PGlite, it: string) => { const l = await un(db, `SELECT cout_cump FROM cump_sorties WHERE order_item_id=$1`, [it]); return l?.cout_cump == null ? null : Number(l.cout_cump); };

test.describe('Réceptions partielles sur le schéma de production complet', () => {
  test('la chaîne de production + la migration des réceptions partielles s\'appliquent sans erreur, et les fonctions de main sont intactes', async () => {
    const db = await baseAchats();
    const f = await exec(db, `SELECT proname FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname IN ('reception_create','reception_update','reception_delete','reception_ecarts_stock','cump_traiter_file','reception_commande_enregistrer','reception_commande_annuler') ORDER BY 1`);
    expect(f.map(x => x.proname)).toEqual(['cump_traiter_file', 'reception_commande_annuler', 'reception_commande_enregistrer', 'reception_create', 'reception_delete', 'reception_ecarts_stock', 'reception_update']);
    expect((await un(db, `SELECT cump_auto_actif() a`)).a).toBe(true);
  });

  test('RÉCEPTION PARTIELLE : stock, PUMP et cumul exacts ; la demande CUMP est déposée dans la transaction puis traitée', async () => {
    const db = await baseAchats(); const p = await produit(db, 'P'); const { s, ids } = await commande(db, [{ p, q: 100, cout: 10 }]);
    const r = await enregistrer(db, cle(), s, aujourdhui(), [{ shipment_item_id: ids[0], quantity: 40, unit_cost_ht: 10 }]);
    expect(r.deja).toBe(false); expect(r.etat.statut).toBe('partielle'); expect(r.etat.reste).toBe(60);
    expect(await stock(db, p)).toBe(40); expect(await pump(db, p)).toBe(10);
    expect(await enAttente(db)).toBeGreaterThan(0);                                     // déposée par la base, dans la transaction de la réception
    const t = await traiter(db); expect(t.en_erreur).toBe(0); expect(await enAttente(db)).toBe(0);
  });

  test('DOUBLE RÉCEPTION : rejeu de la même clé (double clic, réponse perdue) = aucun stock en plus ; clé réutilisée avec d\'autres données = refus', async () => {
    const db = await baseAchats(); const p = await produit(db, 'P'); const { s, ids } = await commande(db, [{ p, q: 100, cout: 10 }]);
    const k = cle(); const lignes = [{ shipment_item_id: ids[0], quantity: 40, unit_cost_ht: 10 }];
    await enregistrer(db, k, s, aujourdhui(), lignes);
    const rejeu = await enregistrer(db, k, s, aujourdhui(), lignes);
    expect(rejeu.deja).toBe(true); expect(await stock(db, p)).toBe(40);
    expect((await un(db, `SELECT count(*) n FROM stock_receptions`)).n).toBe(1);
    expect(await refus(() => enregistrer(db, k, s, aujourdhui(), [{ shipment_item_id: ids[0], quantity: 41, unit_cost_ht: 10 }]))).toContain('CLE_REUTILISEE_AUTRES_DONNEES');
    expect(await stock(db, p)).toBe(40);
  });

  test('DÉPASSEMENT : jamais plus que le reste à recevoir, même en deux réceptions successives ; soldée = plus aucune réception possible', async () => {
    const db = await baseAchats(); const p = await produit(db, 'P'); const { s, ids } = await commande(db, [{ p, q: 100, cout: 10 }]);
    await enregistrer(db, cle(), s, aujourdhui(), [{ shipment_item_id: ids[0], quantity: 70, unit_cost_ht: 10 }]);
    expect(await refus(() => enregistrer(db, cle(), s, aujourdhui(), [{ shipment_item_id: ids[0], quantity: 31, unit_cost_ht: 10 }]))).toContain('DEPASSEMENT_COMMANDE');
    const fin = await enregistrer(db, cle(), s, aujourdhui(), [{ shipment_item_id: ids[0], quantity: 30, unit_cost_ht: 10 }]);
    expect(fin.etat.statut).toBe('integrale'); expect(await stock(db, p)).toBe(100);
    expect(await refus(() => enregistrer(db, cle(), s, aujourdhui(), [{ shipment_item_id: ids[0], quantity: 1, unit_cost_ht: 10 }]))).toContain('COMMANDE_DEJA_SOLDEE');
    expect(await stock(db, p)).toBe(100);
  });

  test('STOCK ARTIFICIEL : annuler puis ressaisir ne double jamais le stock ; l\'annulation est REFUSÉE si le stock est déjà réservé ou vendu', async () => {
    const db = await baseAchats(); const p = await produit(db, 'P'); const { s, ids } = await commande(db, [{ p, q: 100, cout: 10 }]);
    const r1 = (await enregistrer(db, cle(), s, aujourdhui(), [{ shipment_item_id: ids[0], quantity: 40, unit_cost_ht: 10 }])).reception_id as string;
    const r2 = (await enregistrer(db, cle(), s, aujourdhui(), [{ shipment_item_id: ids[0], quantity: 30, unit_cost_ht: 16 }])).reception_id as string;
    expect(await stock(db, p)).toBe(70);
    // 60 cartons réservés par une commande client : seulement 10 disponibles, la 2e réception (30) ne peut pas être annulée
    const o = (await un(db, `INSERT INTO orders (status) VALUES ('en_attente') RETURNING id`)).id;
    await db.query(`INSERT INTO order_items (order_id, product_id, product_name, quantity) VALUES ($1,$2,'P',60)`, [o, p]);
    expect(await refus(() => annuler(db, r2))).toContain('STOCK_DEJA_ENGAGE'); expect(await stock(db, p)).toBe(70);
    expect((await un(db, `SELECT annulee_le FROM stock_receptions WHERE id=$1`, [r2])).annulee_le).toBeNull();
    await db.query(`DELETE FROM order_items WHERE order_id=$1`, [o]);
    await annuler(db, r2); expect(await stock(db, p)).toBe(40);
    expect(await refus(() => annuler(db, r2))).toContain('RECEPTION_DEJA_ANNULEE'); expect(await stock(db, p)).toBe(40);   // annulation rejouée : rien de plus retiré
    await enregistrer(db, cle(), s, aujourdhui(), [{ shipment_item_id: ids[0], quantity: 30, unit_cost_ht: 16 }]);            // ressaisie
    expect(await stock(db, p)).toBe(70);
    expect((await un(db, `SELECT received_quantity q FROM shipment_items WHERE id=$1`, [ids[0]])).q).toBe(70);
    expect(r1).toBeTruthy();
  });

  test('RÉCEPTIONS EXISTANTES : les réceptions libres (hors commande) fonctionnent comme avant ; celles rattachées à une commande ne se modifient ni ne se suppriment par les anciennes fonctions', async () => {
    const db = await baseAchats(); const p = await produit(db, 'P'); const { s, ids } = await commande(db, [{ p, q: 100, cout: 10 }]);
    const libre = (await un(db, `SELECT reception_create('F',$1::date,NULL,true,$2::jsonb) id`, [aujourdhui(), JSON.stringify([{ product_id: p, quantity: 5, unit_cost_ht: 12 }])])).id as string;
    expect(await stock(db, p)).toBe(5);
    await db.query(`SELECT reception_update($1,'F',$2::date,NULL,true,$3::jsonb)`, [libre, aujourdhui(), JSON.stringify([{ product_id: p, quantity: 8, unit_cost_ht: 12 }])]);
    expect(await stock(db, p)).toBe(8);                                                    // correctif différentiel de main : seule la différence est appliquée
    const liee = (await enregistrer(db, cle(), s, aujourdhui(), [{ shipment_item_id: ids[0], quantity: 40, unit_cost_ht: 10 }])).reception_id as string;
    expect(await refus(() => db.query(`SELECT reception_update($1,'F',$2::date,NULL,true,$3::jsonb)`, [liee, aujourdhui(), JSON.stringify([{ product_id: p, quantity: 1, unit_cost_ht: 1 }])]))).toContain('RECEPTION_LIEE_COMMANDE');
    expect(await refus(() => db.query(`SELECT reception_delete($1)`, [liee]))).toContain('RECEPTION_LIEE_COMMANDE');
    expect(await refus(() => db.query(`DELETE FROM stock_reception_items WHERE reception_id=$1`, [liee]))).toContain('RECEPTION_LIEE_COMMANDE');
    expect(await refus(() => db.query(`UPDATE shipment_items SET received_quantity = 100 WHERE id=$1`, [ids[0]]))).toContain('CUMUL_PROTEGE');
    expect(await stock(db, p)).toBe(48);
    await db.query(`SELECT reception_delete($1)`, [libre]); expect(await stock(db, p)).toBe(40);
  });

  test('MARGES : le CUMP reste chronologique avec des réceptions partielles à des coûts différents ; l\'annulation d\'une réception recalcule les ventes concernées', async () => {
    const db = await baseAchats(); const p = await produit(db, 'P'); const { s, ids } = await commande(db, [{ p, q: 100, cout: 10 }]);
    await enregistrer(db, cle(), s, '2026-10-01', [{ shipment_item_id: ids[0], quantity: 40, unit_cost_ht: 10 }]);
    const v1 = await livrer(db, p, 10, '2026-10-04T08:00:00Z', '2026-10-05T08:00:00Z');                       // avant la 2e réception : coût 10
    const r2 = (await enregistrer(db, cle(), s, '2026-10-10', [{ shipment_item_id: ids[0], quantity: 30, unit_cost_ht: 16 }])).reception_id as string;
    const v2 = await livrer(db, p, 10, '2026-10-14T08:00:00Z', '2026-10-15T08:00:00Z');                       // après : (30×10 + 30×16) / 60 = 13
    expect((await traiter(db)).en_erreur).toBe(0);
    expect(await coutCump(db, v1.it)).toBeCloseTo(10, 9); expect(await coutCump(db, v2.it)).toBeCloseTo(13, 9);
    expect(await stock(db, p)).toBe(50);
    // annulation de la 2e réception (30 reçus, 50 en stock, rien de réservé) : la vente du 15/10 est recalculée à 10
    await annuler(db, r2); expect((await traiter(db)).en_erreur).toBe(0);
    expect(await stock(db, p)).toBe(20); expect(await coutCump(db, v2.it)).toBeCloseTo(10, 9); expect(await coutCump(db, v1.it)).toBeCloseTo(10, 9);
    expect(await enAttente(db)).toBe(0);
  });

  test('MARGES : une réception de commande rejouée (même clé) ne dépose aucune demande ni ne change le coût', async () => {
    const db = await baseAchats(); const p = await produit(db, 'P'); const { s, ids } = await commande(db, [{ p, q: 100, cout: 10 }]);
    const k = cle(); const l = [{ shipment_item_id: ids[0], quantity: 40, unit_cost_ht: 10 }];
    await enregistrer(db, k, s, '2026-10-01', l); await traiter(db); expect(await enAttente(db)).toBe(0);
    await enregistrer(db, k, s, '2026-10-01', l); expect(await enAttente(db)).toBe(0); expect(await pump(db, p)).toBe(10);
  });

  test('FAILLE ÉCARTÉE : la file CUMP n\'empêche jamais la réception (interrupteur coupé ou file verrouillée)', async () => {
    const db = await baseAchats(); const p = await produit(db, 'P'); const { s, ids } = await commande(db, [{ p, q: 100, cout: 10 }]);
    await db.query(`SELECT cump_activer_recalcul_automatique(false)`);
    await enregistrer(db, cle(), s, aujourdhui(), [{ shipment_item_id: ids[0], quantity: 40, unit_cost_ht: 10 }]);
    expect(await stock(db, p)).toBe(40); expect(await enAttente(db)).toBe(0);               // réception faite, aucune demande déposée (interrupteur coupé), rien de cassé
  });
});
