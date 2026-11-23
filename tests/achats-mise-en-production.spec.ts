/**
 * Séquence de la fenêtre de mise en production, rejouée sur une base locale PGlite au schéma de PRODUCTION (avec les vrais identifiants de FA/1) :
 * gel → migration → (nouveau code) → tests techniques sans mouvement de stock → DÉGEL IMMÉDIAT → première réception réelle ensuite ;
 * et les retours arrière ciblés. Les scripts joués sont ceux du dépôt (contenu des fichiers). Aucune connexion distante, aucune écriture en production.
 * Preuve visée : fonctionnement à chaque étape, droits d'avant rétablis EXACTEMENT, aucune commande, réception ni stock supprimé ou modifié par les retours.
 */
import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import type { PGlite } from '@electric-sql/pglite';
import { un, exec, MIGRATION } from './helpers/achatsBase';
import { baseFA1, SHIP, LIGNES, TRIPLE_CHOC, ACTEUR } from './helpers/fa1Base';

const lire = (f: string) => readFileSync(f, 'utf8');
const GEL = lire('supabase/transition/achats_gel_receptions_base.sql');
const DEGEL = lire('supabase/transition/achats_degel_receptions_base.sql');
const RETOUR_A = lire('supabase/retours/achats_receptions_partielles_retour.sql');
const DESACTIVATION = lire('supabase/retours/achats_receptions_partielles_desactivation.sql');
const FONCTIONS = ['reception_create', 'reception_update', 'reception_delete'];

const srv = async (db: PGlite, sql: string, p: unknown[] = []) => {
  await db.exec('SET ROLE service_role');
  try { return { rows: (await db.query<any>(sql, p)).rows, erreur: '' }; } catch (e: any) { return { rows: [] as any[], erreur: String(e.message) }; } finally { await db.exec('RESET ROLE'); }
};
const lancer = async (db: PGlite, sql: string) => { try { await db.exec(sql); return ''; } catch (e: any) { try { await db.exec('ROLLBACK'); } catch {} return String(e.message); } };
const acl = async (db: PGlite) => (await exec(db, `SELECT p.oid::regprocedure::text AS f, p.proacl::text AS acl FROM pg_proc p WHERE p.pronamespace='public'::regnamespace AND p.proname = ANY($1) ORDER BY 1`, [FONCTIONS]));
/** Empreinte du SCHÉMA : définitions de toutes les fonctions, colonnes, déclencheurs, droits des fonctions. */
const schema = async (db: PGlite) => (await un(db, `SELECT
  (SELECT md5(string_agg(pg_get_functiondef(p.oid) || coalesce(p.proacl::text, ''), E'\n' ORDER BY p.oid::regprocedure::text)) FROM pg_proc p WHERE p.pronamespace='public'::regnamespace AND p.prokind='f') AS fonctions,
  (SELECT md5(string_agg(table_name || '.' || column_name || ':' || data_type, ',' ORDER BY table_name, column_name)) FROM information_schema.columns WHERE table_schema='public') AS colonnes,
  (SELECT md5(string_agg(tgrelid::regclass::text || '.' || tgname, ',' ORDER BY tgrelid::regclass::text, tgname)) FROM pg_trigger WHERE NOT tgisinternal) AS declencheurs`));
/** Empreinte des DONNÉES : commandes clients, lignes, réceptions, lignes de réception, commandes fournisseurs, stocks, journal. */
const donnees = async (db: PGlite) => (await un(db, `SELECT
  (SELECT md5(string_agg(o::text, E'\n' ORDER BY o.id)) FROM orders o) AS commandes, (SELECT md5(string_agg(i::text, E'\n' ORDER BY i.id)) FROM order_items i) AS lignes_commandes,
  (SELECT md5(string_agg(concat_ws('|', r.id, r.received_at, r.supplier_name, r.stock_applied, r.notes), E'\n' ORDER BY r.id)) FROM stock_receptions r) AS receptions,
  (SELECT md5(string_agg(concat_ws('|', i.id, i.reception_id, i.product_id, i.quantity, i.unit_cost_ht), E'\n' ORDER BY i.id)) FROM stock_reception_items i) AS lignes_receptions,
  (SELECT md5(string_agg(concat_ws('|', s.id, s.reference, s.status), E'\n' ORDER BY s.id)) FROM shipments s) AS commandes_fournisseurs,
  (SELECT md5(string_agg(concat_ws('|', p.id, p.stock_quantity, p.prix_achat_moyen_ht, p.in_stock), E'\n' ORDER BY p.id)) FROM products p) AS stocks_pump,
  (SELECT count(*)::int FROM admin_audit_logs) AS journal`));
const enr = (db: PGlite, ligne: string, q: number, shipment = SHIP) => srv(db, `SELECT reception_commande_enregistrer(gen_random_uuid(),$1,CURRENT_DATE,'BL',NULL,$2::jsonb,$3,$4,$5) r`, [shipment, JSON.stringify([{ shipment_item_id: ligne, quantity: q, unit_cost_ht: 17 }]), ...ACTEUR]);
const libre = (db: PGlite, p: string, q: number) => srv(db, `SELECT reception_create('Fournisseur libre', CURRENT_DATE, 'x', true, $1::jsonb) AS id`, [JSON.stringify([{ product_id: p, quantity: q, unit_cost_ht: 12 }])]);
const stock = async (db: PGlite, p: string) => Number((await un(db, `SELECT stock_quantity q FROM products WHERE id=$1`, [p])).q);

/** Une commande fournisseur « ECO OI » sans réception ancienne, 2 produits, pour la première réception réelle. */
async function ajouterEco(db: PGlite) {
  const p1 = (await un(db, `INSERT INTO products (name, price_ht, stock_quantity, tva_rate, in_stock) VALUES ('ECO-1', 10, 0, 0.085, false) RETURNING id`)).id as string;
  const s = (await un(db, `INSERT INTO shipments (supplier_name, reference, status) VALUES ('ECO OI', 'ECO-1', 'dedouanement') RETURNING id`)).id as string;
  const l = (await un(db, `INSERT INTO shipment_items (shipment_id, product_id, quantity, unit_cost_ht) VALUES ($1,$2,100,5) RETURNING id`, [s, p1])).id as string;
  return { p1, s, l };
}
/** Commande client + livraison : ce qui doit continuer à fonctionner à toute étape. */
async function commandeEtLivraison(db: PGlite, p: string) {
  await db.query(`INSERT INTO client_accounts (nom, email, status) VALUES ('Cli', $1, 'actif') ON CONFLICT DO NOTHING`, ['cli@x.fr']);
  const ligne = { product_id: p, product_name: 'x', quantity: 2, unit: 'carton', price_ht_snapshot: 10, tva_rate_snapshot: 0.085, pump_snapshot: 3 };
  const c = await srv(db, `SELECT * FROM order_create_checked($1::jsonb,$2::jsonb)`, [JSON.stringify({ nom: 'Cli', email: 'cli@x.fr' }), JSON.stringify([ligne])]);
  if (c.erreur || !c.rows[0]?.r_order_id) return `création : ${c.erreur || JSON.stringify(c.rows)}`;
  await db.query(`UPDATE orders SET status='livree' WHERE id=$1`, [c.rows[0].r_order_id]);
  const l = await srv(db, `SELECT * FROM order_mark_livree($1)`, [c.rows[0].r_order_id]);
  return l.erreur;
}

test.describe('Fenêtre de mise en production : séquence, dégel immédiat, retours arrière', () => {
  test('SÉQUENCE NOMINALE : gel → migration → tests techniques → dégel IMMÉDIAT sans aucune réception réelle ; droits rétablis exactement ; tout fonctionne à chaque étape', async () => {
    const db = await baseFA1(false); const eco = await ajouterEco(db); const prodFA1 = LIGNES[4][1];
    const aclAvant = await acl(db); const sch0 = await schema(db);
    expect(aclAvant.every(a => /service_role=X/.test(a.acl) && !/anon|authenticated/.test(a.acl))).toBe(true);        // état de production : service_role seulement

    // ÉTAPE 1 — gel
    expect(await lancer(db, GEL)).toBe('');
    expect((await acl(db)).every(a => !/service_role/.test(a.acl))).toBe(true);
    expect((await libre(db, prodFA1, 1)).erreur).toContain('permission denied');
    expect(await commandeEtLivraison(db, prodFA1)).toBe('');                                                  // commandes clients et livraisons : intactes pendant le gel

    // ÉTAPE 3 — migration (contenu LF du dépôt), gel toujours actif
    expect(await lancer(db, MIGRATION)).toBe('');
    expect((await libre(db, prodFA1, 1)).erreur).toContain('permission denied');
    const stockAvantTests = await stock(db, eco.p1); const don = await donnees(db);

    // TESTS TECHNIQUES sans mouvement de stock : quantités à 0 refusées, dépassement refusé, aucune ligne, aucune donnée
    expect((await enr(db, eco.l, 0, eco.s)).erreur).toContain('AUCUNE_QUANTITE');
    expect((await enr(db, eco.l, 101, eco.s)).erreur).toContain('DEPASSEMENT_COMMANDE');
    expect((await srv(db, `SELECT reception_commande_annuler(gen_random_uuid(),'test',$1,$2,$3) r`, ACTEUR)).erreur).toContain('RECEPTION_INTROUVABLE');
    expect(await stock(db, eco.p1)).toBe(stockAvantTests); expect(await donnees(db)).toEqual(don);

    // DÉGEL IMMÉDIAT (aucune réception réelle n'a eu lieu)
    expect(await lancer(db, DEGEL)).toBe('');
    expect(await acl(db)).toEqual(aclAvant);                                                                             // droits EXACTEMENT ceux d'avant le gel (texte identique)
    expect(await donnees(db)).toEqual(don);
    // après le dégel : les réceptions LIBRES fonctionnent (création, correction, suppression) avec le correctif des stocks…
    const id = (await libre(db, prodFA1, 5)).rows[0].id as string; const s0 = await stock(db, prodFA1);
    expect((await srv(db, `SELECT reception_update($1,'Fournisseur libre',CURRENT_DATE,'x',true,$2::jsonb)`, [id, JSON.stringify([{ product_id: prodFA1, quantity: 8, unit_cost_ht: 12 }])])).erreur).toBe('');
    expect(await stock(db, prodFA1)).toBe(s0 + 3);
    expect((await srv(db, `SELECT reception_delete($1)`, [id])).erreur).toBe(''); expect(await stock(db, prodFA1)).toBe(s0 - 5);
    // …et AUCUNE d'elles ne peut toucher une commande : pas de rattachement, pas de cumul direct (l'ancien chemin est impossible même après le dégel)
    expect((await srv(db, `UPDATE shipment_items SET received_quantity = 5 WHERE id=$1`, [eco.l])).erreur).toContain('CUMUL_PROTEGE');
    // PREMIÈRE RÉCEPTION RÉELLE, ensuite : stock exact, cumul, état
    expect((await enr(db, eco.l, 40, eco.s)).erreur).toBe('');
    expect(await stock(db, eco.p1)).toBe(40); expect((await un(db, `SELECT shipment_reception_etat($1) e`, [eco.s])).e).toMatchObject({ recu: 40, reste: 60, statut: 'partielle' });
    expect(sch0.colonnes).not.toBe((await schema(db)).colonnes);                                                         // la migration est bien en place
  });

  test('RETOUR A (échec après la migration, aucune réception de commande) : retrait + dégel = SCHÉMA et DONNÉES identiques à l\'état d\'avant, rien de supprimé ni de modifié', async () => {
    const db = await baseFA1(false); await ajouterEco(db); const prodFA1 = LIGNES[4][1];
    const sch0 = await schema(db); const don0 = await donnees(db); const acl0 = await acl(db);
    await db.exec(GEL); await db.exec(MIGRATION);
    expect(await lancer(db, RETOUR_A)).toBe(''); expect(await lancer(db, DEGEL)).toBe('');
    expect(await schema(db)).toEqual(sch0); expect(await donnees(db)).toEqual(don0); expect(await acl(db)).toEqual(acl0);
    expect((await libre(db, prodFA1, 2)).erreur).toBe('');                                                               // état fonctionnel retrouvé
    expect(await commandeEtLivraison(db, prodFA1)).toBe('');
  });

  test('RETOUR B (échec APRÈS de vraies réceptions de commande) : désactivation sans rien supprimer ; le retrait complet est REFUSÉ ; réceptions, cumuls et stocks intacts ; réceptions libres fonctionnelles', async () => {
    const db = await baseFA1(false); const eco = await ajouterEco(db); const prodFA1 = LIGNES[4][1];
    await db.exec(GEL); await db.exec(MIGRATION); await db.exec(DEGEL);
    expect((await enr(db, eco.l, 40, eco.s)).erreur).toBe('');
    const don = await donnees(db); const cumul = (await un(db, `SELECT received_quantity q FROM shipment_items WHERE id=$1`, [eco.l])).q;
    expect(await lancer(db, RETOUR_A)).toContain('RETOUR_REFUSE');                                                       // refus : détruirait la trace de vraies entrées
    expect(await donnees(db)).toEqual(don);
    expect(await lancer(db, DESACTIVATION)).toBe('');
    expect((await enr(db, eco.l, 10, eco.s)).erreur).toContain('permission denied');                                     // le nouveau parcours est fermé…
    expect(await donnees(db)).toEqual(don); expect((await un(db, `SELECT received_quantity q FROM shipment_items WHERE id=$1`, [eco.l])).q).toBe(cumul);   // …sans rien changer
    expect((await libre(db, prodFA1, 2)).erreur).toBe('');                                                               // réceptions libres et commandes clients : fonctionnelles
    expect(await commandeEtLivraison(db, prodFA1)).toBe('');
    expect((await un(db, `SELECT shipment_reception_etat($1) e`, [eco.s])).e).toMatchObject({ recu: 40 });               // la lecture de l'état reste disponible
  });

  test('RETOUR de l\'étape 1 seule : gel puis dégel = droits et données identiques ; le gel se rejoue sans effet et le dégel aussi', async () => {
    const db = await baseFA1(false); const acl0 = await acl(db); const don0 = await donnees(db); const sch0 = await schema(db);
    await db.exec(GEL); await db.exec(GEL); expect((await acl(db)).every(a => !/service_role/.test(a.acl))).toBe(true);
    await db.exec(DEGEL); await db.exec(DEGEL);
    expect(await acl(db)).toEqual(acl0); expect(await donnees(db)).toEqual(don0); expect(await schema(db)).toEqual(sch0);
  });

  test('RÈGLE : tout retour à l\'ancien code est précédé d\'un NOUVEAU gel — sans lui, l\'ancien parcours augmente le stock puis échoue sur le cumul ; avec le re-gel, rien n\'est écrit', async () => {
    const db = await baseFA1(false); const eco = await ajouterEco(db);
    await db.exec(GEL); await db.exec(MIGRATION); await db.exec(DEGEL);                                                  // état après dégel
    await db.exec(GEL);                                                                                                  // RE-GEL avant un éventuel retour à l'ancien déploiement
    const s0 = await stock(db, eco.p1);
    expect((await libre(db, eco.p1, 10)).erreur).toContain('permission denied'); expect(await stock(db, eco.p1)).toBe(s0);
    await db.exec(DEGEL);
  });
});
