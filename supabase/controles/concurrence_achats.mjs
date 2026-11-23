// Tests de concurrence RÉELS des RÉCEPTIONS PARTIELLES (vrai PostgreSQL local, connexions simultanées) sur le schéma de PRODUCTION complet :
// migrations de main déjà appliquées (correctif des stocks de réception, moteur CUMP, recalcul automatique actif) + achats_receptions_partielles.sql.
// Installer à part  npm i embedded-postgres pg  dans un dossier temporaire, y copier ce fichier et lancer :  PGDIR=<dossier jetable> node concurrence_achats.mjs
// Aucune connexion à Supabase. Les chemins du dépôt (REPO) sont à adapter.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const EmbeddedPostgres = require('embedded-postgres').default;
const { Client } = require('pg');

const REPO = process.env.REPO ?? 'C:/projets/inca-import';
const helper = readFileSync(`${REPO}/tests/helpers/receptionsBase.ts`, 'utf8');
const ENV = helper.split('export const ENV = `')[1].split('`;')[0];
const LISTE = [...helper.split('export const MIGRATIONS_AVANT = [')[1].split('];')[0].matchAll(/'([a-z_0-9]+\.sql)'/g)].map(m => m[1]);
const migr = f => readFileSync(`${REPO}/supabase/migrations/${f}`, 'utf8');

const pg = new EmbeddedPostgres({ databaseDir: process.env.PGDIR, user: 'postgres', password: 'pw', port: 54342, persistent: false, initdbFlags: ['--locale=C', '--encoding=UTF8'] });
await pg.initialise(); await pg.start(); await pg.createDatabase('t');
const nouveau = async () => { const c = new Client({ host: '127.0.0.1', port: 54342, user: 'postgres', password: 'pw', database: 't' }); await c.connect(); await c.query(`SET statement_timeout = '40s'; SET lock_timeout = '30s'`); return c; };
const adm = await nouveau();
await adm.query(ENV);
for (const f of [...LISTE, 'receptions_stock_differentiel.sql', 'cump_glissant.sql', 'cump_methode_v2.sql', 'cump_recalcul_automatique.sql', 'achats_receptions_partielles.sql']) { try { await adm.query(migr(f)); } catch (e) { throw new Error(`${f}: ${e.message}`); } }
await adm.query(`SELECT cump_activer_recalcul_automatique(true)`);

let n = 0; const sleep = ms => new Promise(r => setTimeout(r, ms));
const q = async (sql, p = []) => (await adm.query(sql, p)).rows;
const un = async (sql, p) => (await q(sql, p))[0];
const produit = async (stock = 0) => (await un(`INSERT INTO products (name, price_ht, stock_quantity, tva_rate, in_stock) VALUES ($1, 10, $2, 0.085, $2 > 0) RETURNING id`, ['P' + ++n, stock])).id;
const commande = async lignes => { const s = (await un(`INSERT INTO shipments (supplier_name, reference, status) VALUES ('F', $1, 'en_transit') RETURNING id`, ['R' + ++n])).id; const ids = []; for (const [p, qte, c] of lignes) ids.push((await un(`INSERT INTO shipment_items (shipment_id, product_id, quantity, unit_cost_ht) VALUES ($1,$2,$3,$4) RETURNING id`, [s, p, qte, c ?? 10])).id); return { s, ids }; };
const ACT = ['00000000-0000-0000-0000-0000000000a1', 'admin@inca.test', 'admin'];
const aujourdhui = (await un(`SELECT ((now() AT TIME ZONE 'UTC') + interval '4 hours')::date d`)).d.toISOString().slice(0, 10);
const uuid = () => crypto.randomUUID();
const enr = (c, k, s, items, date = aujourdhui) => c.query(`SELECT reception_commande_enregistrer($1,$2,$3::date,'BL',NULL,$4::jsonb,$5,$6,$7) r`, [k, s, date, JSON.stringify(items), ...ACT]);
const ann = (c, r) => c.query(`SELECT reception_commande_annuler($1,'erreur de saisie',$2,$3,$4) r`, [r, ...ACT]);
const L = (item, qte, cout = 10) => ({ shipment_item_id: item, quantity: qte, unit_cost_ht: cout });
const stock = async p => Number((await un(`SELECT stock_quantity q FROM products WHERE id=$1`, [p])).q);
const cumul = async i => Number((await un(`SELECT coalesce(received_quantity,0) q FROM shipment_items WHERE id=$1`, [i])).q);

/** Exécute `corps` dans UNE transaction (connexion propre), garde les verrous `tenir` ms avant de valider. */
async function tache(corps, { tenir = 0, apres = 0 } = {}) {
  await sleep(apres); const c = await nouveau(); const t0 = Date.now(); let erreur = null, valeur = null;
  try { await c.query('BEGIN'); valeur = await corps(c); if (tenir) await c.query(`SELECT pg_sleep(${tenir / 1000})`); await c.query('COMMIT'); }
  catch (e) { erreur = e.message; try { await c.query('ROLLBACK'); } catch {} }
  const ms = Date.now() - t0; await c.end(); return { ms, erreur, valeur };
}
const interblocage = x => x.erreur && /deadlock|40P01|interblocage/i.test(x.erreur);
const resultats = []; let ok = true;
const verifier = (nom, cond, detail = '') => { resultats.push(`${cond ? 'OK ' : 'ÉCHEC'}  ${nom}${detail ? '  — ' + detail : ''}`); if (!cond) ok = false; };
const reponse = x => x.erreur ? x.erreur.slice(0, 40) : (x.valeur?.rows?.[0]?.r?.deja ? 'rejeu' : 'ok');

// A1 — DEUX réceptions simultanées de 60 sur une ligne de 100 : une seule passe, jamais 120
{
  const p = await produit(); const { s, ids } = await commande([[p, 100]]);
  const rs = await Promise.all([tache(c => enr(c, uuid(), s, [L(ids[0], 60)])), tache(c => enr(c, uuid(), s, [L(ids[0], 60)]))]);
  const reussies = rs.filter(x => !x.erreur).length; const refus = rs.filter(x => x.erreur?.includes('DEPASSEMENT_COMMANDE')).length;
  verifier('A1 deux réceptions simultanées de 60 sur 100 : exactement une réussit, l\'autre est refusée (DEPASSEMENT_COMMANDE), aucun interblocage', reussies === 1 && refus === 1 && !rs.some(interblocage), rs.map(reponse).join(' / '));
  verifier('A1 stock 60 et cumul 60 (jamais 120)', (await stock(p)) === 60 && (await cumul(ids[0])) === 60, `stock ${await stock(p)}, cumul ${await cumul(ids[0])}`);
}
// A2 — TROIS envois simultanés de la MÊME clé (triple clic) : une seule réception, un seul ajout de stock
{
  const p = await produit(); const { s, ids } = await commande([[p, 100]]); const k = uuid();
  const rs = await Promise.all([1, 2, 3].map(() => tache(c => enr(c, k, s, [L(ids[0], 40)]))));
  verifier('A2 trois envois simultanés de la même clé : aucune erreur, un seul stock ajouté', rs.every(x => !x.erreur) && (await stock(p)) === 40 && (await cumul(ids[0])) === 40, rs.map(reponse).join(' / ') + `, stock ${await stock(p)}`);
  verifier('A2 une seule réception enregistrée', (await un(`SELECT count(*)::int n FROM stock_receptions WHERE shipment_id=$1`, [s])).n === 1);
}
// A3 — CINQ réceptions simultanées de 20 sur 100 : toutes passent, la commande est soldée, la sixième est refusée
{
  const p = await produit(); const { s, ids } = await commande([[p, 100]]);
  const rs = await Promise.all([1, 2, 3, 4, 5].map(() => tache(c => enr(c, uuid(), s, [L(ids[0], 20)]))));
  verifier('A3 cinq réceptions simultanées de 20 sur 100 : toutes réussies, stock 100, cumul 100', rs.every(x => !x.erreur) && (await stock(p)) === 100 && (await cumul(ids[0])) === 100, rs.map(reponse).join(' / '));
  const sixieme = await tache(c => enr(c, uuid(), s, [L(ids[0], 1)])); verifier('A3 la sixième est refusée (commande soldée)', sixieme.erreur?.includes('COMMANDE_DEJA_SOLDEE') && (await stock(p)) === 100, reponse(sixieme));
}
// A4 — deux commandes qui partagent deux produits, lignes dans des ordres opposés : aucun interblocage
{
  const a = await produit(), b = await produit(); const c1 = await commande([[a, 50], [b, 50]]), c2 = await commande([[b, 50], [a, 50]]);
  const rs = await Promise.all([tache(c => enr(c, uuid(), c1.s, [L(c1.ids[0], 10), L(c1.ids[1], 10)]), { tenir: 400 }), tache(c => enr(c, uuid(), c2.s, [L(c2.ids[0], 10), L(c2.ids[1], 10)]), { apres: 50 })]);
  verifier('A4 deux commandes aux produits croisés : aucune erreur ni interblocage', rs.every(x => !x.erreur), rs.map(reponse).join(' / '));
  verifier('A4 stocks exacts (20 chacun)', (await stock(a)) === 20 && (await stock(b)) === 20);
}
// A5 — réception partielle pendant la livraison d'une commande client du même produit
{
  const p = await produit(50); const { s, ids } = await commande([[p, 100]]);
  const o = (await un(`INSERT INTO orders (status) VALUES ('en_attente') RETURNING id`)).id; await q(`INSERT INTO order_items (order_id, product_id, product_name, quantity, price_ht_snapshot) VALUES ($1,$2,'x',30,20)`, [o, p]);
  const rs = await Promise.all([tache(c => enr(c, uuid(), s, [L(ids[0], 40)]), { tenir: 800 }),
    tache(async c => { await c.query(`UPDATE orders SET status='livree' WHERE id=$1`, [o]); await c.query(`SELECT * FROM order_mark_livree($1)`, [o]); }, { apres: 100 })]);
  verifier('A5 réception + livraison simultanées du même produit : aucune erreur ni interblocage', rs.every(x => !x.erreur), rs.map(reponse).join(' / '));
  verifier('A5 stock exact : 50 + 40 − 30 = 60', (await stock(p)) === 60, `stock ${await stock(p)}`);
}
// A6 — annulation d'une réception pendant l'enregistrement d'une autre sur la même commande
{
  const p = await produit(); const { s, ids } = await commande([[p, 100]]);
  const r1 = (await un(`SELECT reception_commande_enregistrer($1,$2,$3::date,'BL',NULL,$4::jsonb,$5,$6,$7) r`, [uuid(), s, aujourdhui, JSON.stringify([L(ids[0], 40)]), ...ACT])).r.reception_id;
  const rs = await Promise.all([tache(c => ann(c, r1), { tenir: 500 }), tache(c => enr(c, uuid(), s, [L(ids[0], 30)]), { apres: 50 })]);
  verifier('A6 annulation + nouvelle réception simultanées : réussies sans interblocage', rs.every(x => !x.erreur), rs.map(reponse).join(' / '));
  verifier('A6 stock et cumul cohérents : 30', (await stock(p)) === 30 && (await cumul(ids[0])) === 30, `stock ${await stock(p)}, cumul ${await cumul(ids[0])}`);
}
// A7 — DEUX annulations simultanées de la même réception : retirée une seule fois
{
  const p = await produit(); const { s, ids } = await commande([[p, 100]]);
  const r1 = (await un(`SELECT reception_commande_enregistrer($1,$2,$3::date,'BL',NULL,$4::jsonb,$5,$6,$7) r`, [uuid(), s, aujourdhui, JSON.stringify([L(ids[0], 40)]), ...ACT])).r.reception_id;
  await q(`UPDATE products SET stock_quantity = stock_quantity + 25 WHERE id=$1`, [p]);          // 25 cartons d'une autre origine : le stock total est 65
  const rs = await Promise.all([tache(c => ann(c, r1)), tache(c => ann(c, r1))]);
  verifier('A7 deux annulations simultanées : une réussit, l\'autre est refusée (RECEPTION_DEJA_ANNULEE)', rs.filter(x => !x.erreur).length === 1 && rs.some(x => x.erreur?.includes('RECEPTION_DEJA_ANNULEE')), rs.map(reponse).join(' / '));
  verifier('A7 stock retiré UNE seule fois : 65 − 40 = 25 (jamais 0 ni négatif)', (await stock(p)) === 25 && (await cumul(ids[0])) === 0, `stock ${await stock(p)}, cumul ${await cumul(ids[0])}`);
}
// A8 — réception de commande pendant la correction (différentielle) d'une réception libre du même produit
{
  const p = await produit(); const { s, ids } = await commande([[p, 100]]);
  const libre = (await un(`SELECT reception_create('F',$1::date,NULL,true,$2::jsonb) id`, [aujourdhui, JSON.stringify([{ product_id: p, quantity: 10, unit_cost_ht: 12 }])])).id;
  const rs = await Promise.all([tache(c => enr(c, uuid(), s, [L(ids[0], 40)]), { tenir: 600 }),
    tache(c => c.query(`SELECT reception_update($1,'F',$2::date,NULL,true,$3::jsonb)`, [libre, aujourdhui, JSON.stringify([{ product_id: p, quantity: 15, unit_cost_ht: 12 }])]), { apres: 80 })]);
  verifier('A8 réception de commande + correction d\'une réception libre : aucune erreur ni interblocage', rs.every(x => !x.erreur), rs.map(reponse).join(' / '));
  verifier('A8 stock exact : 40 + 15 = 55', (await stock(p)) === 55, `stock ${await stock(p)}`);
}
// A9 — le moteur CUMP converge après tout cela (file vidée, aucun échec)
{
  for (let i = 0; i < 8; i++) { await q(`SELECT cump_traiter_file(200)`); await q(`SELECT cump_detecter_obsoletes()`); if (!(await un(`SELECT count(*)::int n FROM cump_file WHERE statut='en_attente'`)).n) break; }
  const f = await un(`SELECT count(*) FILTER (WHERE statut='en_attente')::int a, count(*) FILTER (WHERE statut='echoue')::int e FROM cump_file`);
  verifier('A9 la file CUMP converge : plus rien en attente ni en échec', f.a === 0 && f.e === 0, JSON.stringify(f));
}
// Bilan global
{
  await sleep(300);
  const att = await un(`SELECT count(*)::int n FROM pg_stat_activity WHERE datname='t' AND pid <> pg_backend_pid() AND (wait_event_type='Lock' OR state LIKE 'idle in transaction%')`);
  verifier('Aucun verrou en attente ni transaction oubliée à la fin', att.n === 0);
  verifier('Aucun stock négatif', (await un(`SELECT count(*)::int n FROM products WHERE stock_quantity < 0`)).n === 0);
  const inc = await un(`SELECT count(*)::int n FROM shipment_items i WHERE coalesce(i.received_quantity,0) <> coalesce((SELECT sum(ri.quantity) FROM stock_reception_items ri JOIN stock_receptions r ON r.id=ri.reception_id WHERE ri.shipment_item_id=i.id AND r.annulee_le IS NULL),0)`);
  verifier('Cumul de chaque ligne de commande = somme exacte de ses réceptions non annulées', inc.n === 0, `${inc.n} incohérence(s)`);
  verifier('Aucune ligne reçue au-delà de la quantité commandée', (await un(`SELECT count(*)::int n FROM shipment_items WHERE coalesce(received_quantity,0) > quantity`)).n === 0);
}
console.log('=== CONCURRENCE RÉELLE DES RÉCEPTIONS PARTIELLES ==='); console.log(resultats.join('\n')); console.log(ok ? 'TOUT EST CONFORME' : 'AU MOINS UN ÉCHEC');
await adm.end(); await pg.stop();
