// Tests de concurrence RÉELS (vrai PostgreSQL local, connexions simultanées). Hors dépôt de dépendances : installer à part  npm i embedded-postgres pg  dans un dossier temporaire,
// y copier ce fichier et lancer :  PGDIR=<dossier jetable> node concurrence.mjs [ancien]   (« ancien » = fonctions d'origine, pour comparaison). Aucune connexion à Supabase.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const EmbeddedPostgres = require('embedded-postgres').default;
const { Client } = require('pg');

const REPO = 'C:/projets/inca-import';
const helper = readFileSync(`${REPO}/tests/helpers/receptionsBase.ts`, 'utf8');
const ENV = helper.split('export const ENV = `')[1].split('`;')[0];
const LISTE = [...helper.split('export const MIGRATIONS_AVANT = [')[1].split('];')[0].matchAll(/'([a-z_0-9]+\.sql)'/g)].map(m => m[1]);
const migr = f => readFileSync(`${REPO}/supabase/migrations/${f}`, 'utf8');
const AVEC_CORRECTIF = process.argv[2] !== 'ancien';

const pg = new EmbeddedPostgres({ databaseDir: process.env.PGDIR, user: 'postgres', password: 'pw', port: 54329, persistent: false, initdbFlags: ['--locale=C', '--encoding=UTF8'] });
await pg.initialise(); await pg.start(); await pg.createDatabase('t');
const nouveau = async () => { const c = new Client({ host: '127.0.0.1', port: 54329, user: 'postgres', password: 'pw', database: 't' }); await c.connect(); await c.query(`SET statement_timeout = '30s'; SET lock_timeout = '20s'`); return c; };
const adm = await nouveau();
await adm.query(ENV);
for (const f of LISTE) { try { await adm.query(migr(f)); } catch (e) { throw new Error(`${f}: ${e.message}`); } }
if (AVEC_CORRECTIF) await adm.query(migr('receptions_stock_differentiel.sql'));
await adm.query(`INSERT INTO client_accounts (nom, email, status) VALUES ('Cli','cli@test.local','actif')`);

let n = 0; const sleep = ms => new Promise(r => setTimeout(r, ms));
const q = async (sql, p = []) => (await adm.query(sql, p)).rows;
const un = async (sql, p) => (await q(sql, p))[0];
const produit = async (stock = 0) => (await un(`INSERT INTO products (name, price_ht, stock_quantity, tva_rate, in_stock) VALUES ($1, 10, 0, 0.085, false) RETURNING id`, ['P' + ++n])).id;
const J = l => JSON.stringify(l.map(x => ({ product_id: x.p, quantity: x.q, unit_cost_ht: x.c ?? 5 })));
const creer = async l => (await un(`SELECT reception_create('F','2026-10-28',NULL,true,$1::jsonb) id`, [J(l)])).id;
const stock = async p => (await un(`SELECT stock_quantity s FROM products WHERE id=$1`, [p])).s;
const dispo = async p => (await un(`SELECT physical, reserved, available FROM product_availability WHERE product_id=$1`, [p]));
const commande = async (lignes) => { const r = await un(`SELECT * FROM order_create_checked($1::jsonb,$2::jsonb)`, [JSON.stringify({ nom: 'Cli', email: 'cli@test.local' }), JSON.stringify(lignes.map(l => ({ product_id: l.p, product_name: 'x', quantity: l.q, unit: 'carton' })))]); if (r.r_conflicts?.length) throw new Error('commande refusée ' + JSON.stringify(r.r_conflicts)); return r.r_order_id; };

/** Exécute `corps` dans UNE transaction sur sa propre connexion, puis garde les verrous `tenir` ms avant de valider. Retourne durée, erreur éventuelle. */
async function tache(corps, { tenir = 0, apres = 0 } = {}) {
  await sleep(apres); const c = await nouveau(); const t0 = Date.now(); let erreur = null, valeur = null;
  try { await c.query('BEGIN'); valeur = await corps(c); if (tenir) await c.query(`SELECT pg_sleep(${tenir / 1000})`); await c.query('COMMIT'); }
  catch (e) { erreur = e.message; try { await c.query('ROLLBACK'); } catch {} }
  const ms = Date.now() - t0; await c.end(); return { ms, erreur, valeur };
}
const maj = (r, l, appl = true) => c => c.query(`SELECT reception_update($1,'F','2026-10-28',NULL,$2,$3::jsonb)`, [r, appl, J(l)]);
const livrer = o => c => c.query(`SELECT * FROM order_mark_livree($1)`, [o]);

const resultats = []; let ok = true;
const verifier = (nom, cond, detail = '') => { resultats.push(`${cond ? 'OK ' : 'ÉCHEC'}  ${nom}${detail ? '  — ' + detail : ''}`); if (!cond) ok = false; };
const invariant = async (p, vendu = 0) => (await un(`SELECT coalesce(sum(i.quantity),0)::int q FROM stock_reception_items i JOIN stock_receptions r ON r.id=i.reception_id WHERE r.stock_applied AND i.product_id=$1`, [p])).q - vendu;

// S1 — deux modifications simultanées de la MÊME réception
{
  const p = await produit(); const r = await creer([{ p, q: 100 }]);
  const [a, b] = await Promise.all([tache(maj(r, [{ p, q: 90 }]), { tenir: 2000 }), tache(maj(r, [{ p, q: 80 }]), { apres: 400 })]);
  const s = await stock(p); const rec = (await un(`SELECT quantity FROM stock_reception_items WHERE reception_id=$1`, [r])).quantity;
  verifier('S1 même réception ×2 : la seconde attend la première (verrou)', b.ms >= 1400 && !a.erreur && !b.erreur, `A ${a.ms} ms, B ${b.ms} ms`);
  verifier('S1 aucune mise à jour perdue : stock = quantité de la réception finale', s === rec && s === (await invariant(p)), `stock ${s}, réception ${rec}`);
}
// S1b — même réception, deux modifications dont la 2e ferait passer sous le stock restant (ventes entre-temps)
{
  const p = await produit(); const r = await creer([{ p, q: 100 }]); await q(`UPDATE products SET stock_quantity = 30 WHERE id=$1`, [p]);   // 70 vendus
  const [a, b] = await Promise.all([tache(maj(r, [{ p, q: 90 }]), { tenir: 1500 }), tache(maj(r, [{ p, q: 10 }]), { apres: 300 })]);
  verifier('S1b : A (−10) réussit, B (−80 alors qu\'il reste 20) est refusé, stock = 20', !a.erreur && /STOCK_INSUFFISANT/.test(b.erreur ?? '') && (await stock(p)) === 20, `A ${a.erreur ?? 'ok'} / B ${b.erreur ?? 'ok'} / stock ${await stock(p)}`);
}
// S2 — deux réceptions différentes, même produit
{
  const p = await produit(); const r1 = await creer([{ p, q: 50 }]); const r2 = await creer([{ p, q: 30 }]);
  const [a, b] = await Promise.all([tache(maj(r1, [{ p, q: 60 }]), { tenir: 1500 }), tache(maj(r2, [{ p, q: 20 }]), { apres: 300 })]);
  verifier('S2 deux réceptions, même produit : aucune mise à jour perdue (80 +10 −10 = 80)', !a.erreur && !b.erreur && (await stock(p)) === 80 && (await invariant(p)) === 80, `A ${a.ms} ms, B ${b.ms} ms, stock ${await stock(p)}`);
  verifier('S2 la seconde a bien attendu le verrou du produit', b.ms >= 1000);
}
// S2b — mêmes deux produits, listés dans l'ordre inverse : pas d'interblocage
{
  const x = await produit(), y = await produit(); const r1 = await creer([{ p: x, q: 40 }, { p: y, q: 40 }]); const r2 = await creer([{ p: y, q: 40 }, { p: x, q: 40 }]);
  const [a, b] = await Promise.all([tache(maj(r1, [{ p: x, q: 45 }, { p: y, q: 35 }]), { tenir: 1500 }), tache(maj(r2, [{ p: y, q: 35 }, { p: x, q: 45 }]), { apres: 200 })]);
  verifier('S2b produits en ordre inverse : aucun interblocage, aucune erreur', !a.erreur && !b.erreur, `${a.erreur ?? ''}${b.erreur ?? ''}`);
  verifier('S2b stocks cohérents (x 80+5−… = somme des réceptions)', (await stock(x)) === (await invariant(x)) && (await stock(y)) === (await invariant(y)), `x ${await stock(x)}/${await invariant(x)}, y ${await stock(y)}/${await invariant(y)}`);
}
// S3 — modification de réception PENDANT une sortie de stock (livraison)
{
  const p = await produit(); const r = await creer([{ p, q: 100 }]); const o = await commande([{ p, q: 10 }]);
  const [a, b] = await Promise.all([tache(maj(r, [{ p, q: 110 }]), { tenir: 1500 }), tache(livrer(o), { apres: 300 })]);
  verifier('S3 modification (+10) puis livraison (−10) simultanées : stock final 100, aucune perte', !a.erreur && !b.erreur && (await stock(p)) === 100, `stock ${await stock(p)}, livraison ${b.ms} ms`);
  const p2 = await produit(); const r2 = await creer([{ p: p2, q: 100 }]); const o2 = await commande([{ p: p2, q: 10 }]);
  const [c, d] = await Promise.all([tache(livrer(o2), { tenir: 1500 }), tache(maj(r2, [{ p: p2, q: 90 }]), { apres: 300 })]);
  verifier('S3b livraison (−10) puis modification (−10) simultanées : stock final 80', !c.erreur && !d.erreur && (await stock(p2)) === 80, `stock ${await stock(p2)}`);
}
// S3c — interblocage possible livraison ↔ réception (la livraison verrouille ses lignes dans l'ordre de la commande, non trié)
{
  const [x, y] = [await produit(), await produit()].sort(); const rr = await creer([{ p: x, q: 50 }, { p: y, q: 50 }]);
  const o = await commande([{ p: y, q: 5 }, { p: x, q: 5 }]);                      // ordre INVERSE de l'ordre croissant
  const [a, b] = await Promise.all([tache(livrer(o), { tenir: 0 }), tache(maj(rr, [{ p: x, q: 55 }, { p: y, q: 55 }]), { tenir: 0 })]);
  // la livraison prend y puis x ; la réception prend x puis y : on force le croisement avec une pause dans la livraison
  const o2 = await commande([{ p: y, q: 5 }, { p: x, q: 5 }]); await sleep(50);
  const [c, d] = await Promise.all([tache(async cl => { await cl.query(`SELECT 1 FROM products WHERE id=$1 FOR UPDATE`, [y]); await cl.query(`SELECT pg_sleep(0.8)`); await cl.query(`SELECT * FROM order_mark_livree($1)`, [o2]); }), tache(maj(rr, [{ p: x, q: 60 }, { p: y, q: 60 }]), { apres: 200 })]);
  const dead = [c, d].filter(t => /deadlock/i.test(t.erreur ?? '')).length;
  verifier('S3c croisement livraison/réception : aucun blocage persistant (un interblocage éventuel est détecté et annulé par PostgreSQL, rien n\'est écrit à moitié)', c.ms < 10000 && d.ms < 10000, `interblocages détectés : ${dead} ; ${c.erreur ?? 'ok'} / ${d.erreur ?? 'ok'}`);
  const sx = await stock(x), sy = await stock(y);
  verifier('S3c stocks cohérents après le croisement', Number.isInteger(sx) && sx >= 0 && sy >= 0 && sx + sy === (await invariant(x)) + (await invariant(y)) - (await un(`SELECT coalesce(sum(stock_decremented),0)::int d FROM order_items WHERE product_id IN ($1,$2)`, [x, y])).d, `x ${sx}, y ${sy}`);
}
// S4 — passage sous le réservé
{
  const p = await produit(); const r = await creer([{ p, q: 100 }]); await commande([{ p, q: 60 }]);
  const refus = await tache(maj(r, [{ p, q: 50 }]));
  verifier('S4 réduire à 50 alors que 60 sont réservés : refusé, stock 100', /STOCK_INSUFFISANT/.test(refus.erreur ?? '') && (await stock(p)) === 100, refus.erreur?.slice(0, 80));
  // course : réduction à 70 (réservé 40) pendant qu'une commande réserve 40 de plus
  const p2 = await produit(); const r2 = await creer([{ p: p2, q: 100 }]); await commande([{ p: p2, q: 40 }]);
  const [a, b] = await Promise.all([tache(maj(r2, [{ p: p2, q: 70 }]), { tenir: 1500 }), tache(async c => { const x = await c.query(`SELECT * FROM order_create_checked($1::jsonb,$2::jsonb)`, [JSON.stringify({ nom: 'Cli', email: 'cli@test.local' }), JSON.stringify([{ product_id: p2, product_name: 'x', quantity: 40, unit: 'carton' }])]); return x.rows[0]; }, { apres: 300 })]);
  const d = await dispo(p2);
  verifier('S4b course réduction ↔ nouvelle réservation : jamais de réservé > physique', d.reserved <= d.physical && d.available >= 0, `physique ${d.physical}, réservé ${d.reserved} ; commande ${b.valeur?.r_conflicts?.length ? 'refusée (stock insuffisant)' : 'acceptée'}`);
  const p3 = await produit(); const r3 = await creer([{ p: p3, q: 100 }]);
  const [c, e] = await Promise.all([tache(async c2 => (await c2.query(`SELECT * FROM order_create_checked($1::jsonb,$2::jsonb)`, [JSON.stringify({ nom: 'Cli', email: 'cli@test.local' }), JSON.stringify([{ product_id: p3, product_name: 'x', quantity: 60, unit: 'carton' }])])).rows[0], { tenir: 1500 }), tache(maj(r3, [{ p: p3, q: 70 }]), { apres: 300 })]);
  const d3 = await dispo(p3);
  verifier('S4c réservation de 60 d\'abord, puis réduction à 70 (stock 70 ≥ 60) : acceptée, réservé ≤ physique', !e.erreur && d3.reserved <= d3.physical, `physique ${d3.physical}, réservé ${d3.reserved}`);
}
// S5 — prix seul pendant des mouvements de stock
{
  const p = await produit(); const r = await creer([{ p, q: 100, c: 5 }]); const o = await commande([{ p, q: 10 }]);
  const [a, b, c] = await Promise.all([tache(maj(r, [{ p, q: 100, c: 9 }]), { tenir: 1500 }), tache(livrer(o), { apres: 300 }), tache(async cl => cl.query(`SELECT reception_create('F2','2026-10-29',NULL,true,$1::jsonb)`, [J([{ p, q: 20, c: 6 }])]), { apres: 500 })]);
  verifier('S5 prix seul + livraison (−10) + nouvelle réception (+20) simultanés : stock 110, aucune perte', !a.erreur && !b.erreur && !c.erreur && (await stock(p)) === 110, `stock ${await stock(p)}`);
  verifier('S5 le coût moyen est bien recalculé (≠ 5) et le stock n\'a été touché que par les mouvements', Number((await un(`SELECT prix_achat_moyen_ht x FROM products WHERE id=$1`, [p])).x) > 5);
}
// Bilan : rien ne reste bloqué
{
  await sleep(300);
  const att = await q(`SELECT count(*)::int n FROM pg_stat_activity WHERE datname='t' AND pid <> pg_backend_pid() AND (wait_event_type='Lock' OR state LIKE 'idle in transaction%')`);
  const verr = await q(`SELECT count(*)::int n FROM pg_locks WHERE NOT granted`);
  verifier('Aucun verrou en attente ni transaction oubliée à la fin', att[0].n === 0 && verr[0].n === 0);
  const neg = await q(`SELECT count(*)::int n FROM products WHERE stock_quantity < 0`); verifier('Aucun stock négatif', neg[0].n === 0);
}
console.log(AVEC_CORRECTIF ? '=== AVEC LE CORRECTIF ===' : '=== ANCIENNES FONCTIONS (référence) ==='); console.log(resultats.join('\n')); console.log(ok ? 'TOUT EST CONFORME' : 'AU MOINS UN ÉCHEC');
await adm.end(); await pg.stop();
