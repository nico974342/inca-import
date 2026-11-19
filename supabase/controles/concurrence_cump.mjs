// Tests de concurrence RÉELS du recalcul CUMP (vrai PostgreSQL local, connexions simultanées). Installer à part  npm i embedded-postgres pg  dans un dossier temporaire,
// y copier ce fichier et lancer :  PGDIR=<dossier jetable> node concurrence_cump.mjs   — aucune connexion à Supabase. Les chemins du dépôt (REPO) sont à adapter.
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

const pg = new EmbeddedPostgres({ databaseDir: process.env.PGDIR, user: 'postgres', password: 'pw', port: 54341, persistent: false, initdbFlags: ['--locale=C', '--encoding=UTF8'] });
await pg.initialise(); await pg.start(); await pg.createDatabase('t');
const nouveau = async () => { const c = new Client({ host: '127.0.0.1', port: 54341, user: 'postgres', password: 'pw', database: 't' }); await c.connect(); await c.query(`SET statement_timeout = '40s'; SET lock_timeout = '30s'`); return c; };
const adm = await nouveau();
await adm.query(ENV);
for (const f of [...LISTE, 'receptions_stock_differentiel.sql', 'cump_glissant.sql', 'cump_methode_v2.sql', 'cump_recalcul_automatique.sql']) { try { await adm.query(migr(f)); } catch (e) { throw new Error(`${f}: ${e.message}`); } }
await adm.query(`SELECT cump_activer_recalcul_automatique(true)`);

let n = 0; const sleep = ms => new Promise(r => setTimeout(r, ms));
const q = async (sql, p = []) => (await adm.query(sql, p)).rows;
const un = async (sql, p) => (await q(sql, p))[0];
const produit = async () => (await un(`INSERT INTO products (name, price_ht, stock_quantity, tva_rate, in_stock) VALUES ($1, 10, 0, 0.085, false) RETURNING id`, ['P' + ++n])).id;
const J = (p, qte, c) => JSON.stringify([{ product_id: p, quantity: qte, unit_cost_ht: c }]);
const rec = async (p, qte, c, date) => (await un(`SELECT reception_create('F',$1::date,NULL,true,$2::jsonb) id`, [date, J(p, qte, c)])).id;
async function livrer(p, qte, cree, livre) {
  const snap = (await un(`SELECT prix_achat_moyen_ht s FROM products WHERE id=$1`, [p])).s;
  const cmd = (await un(`INSERT INTO orders (status, created_at) VALUES ('livree', $1::timestamptz) RETURNING id`, [cree])).id;
  await q(`INSERT INTO order_items (order_id, product_id, product_name, quantity, price_ht_snapshot, pump_snapshot) VALUES ($1,$2,'x',$3,20,$4)`, [cmd, p, qte, snap]);
  await q(`SELECT * FROM order_mark_livree($1)`, [cmd]);
  if (livre) await q(`INSERT INTO admin_audit_logs (admin_email, action, target_type, target_id, details, created_at) VALUES ('a@x.local','commande.statut','order',$1,'{"ancien":"en_attente","nouveau":"livree"}'::jsonb,$2::timestamptz)`, [cmd, livre]);
  return cmd;
}
/** Exécute `corps` dans UNE transaction, garde les verrous `tenir` ms avant de valider. */
async function tache(corps, { tenir = 0, apres = 0 } = {}) {
  await sleep(apres); const c = await nouveau(); const t0 = Date.now(); let erreur = null, valeur = null;
  try { await c.query('BEGIN'); valeur = await corps(c); if (tenir) await c.query(`SELECT pg_sleep(${tenir / 1000})`); await c.query('COMMIT'); }
  catch (e) { erreur = e.message; try { await c.query('ROLLBACK'); } catch {} }
  const ms = Date.now() - t0; await c.end(); return { ms, erreur, valeur };
}
const SIM = `WITH RECURSIVE tr AS (SELECT a.target_id, max(a.created_at) t FROM admin_audit_logs a WHERE a.action='commande.statut' AND a.details->>'nouveau'='livree' GROUP BY 1),
  ev AS (SELECT *, row_number() OVER (ORDER BY t,k,tie) n FROM (
    SELECT 0 k, (r.received_at::timestamp AT TIME ZONE 'Indian/Reunion') t, i.quantity qty, i.unit_cost_ht cost, NULL::uuid item_id, i.id tie FROM stock_reception_items i JOIN stock_receptions r ON r.id=i.reception_id WHERE i.product_id=$1
    UNION ALL SELECT 1, coalesce(tr.t,o.created_at), oi.stock_decremented, NULL::numeric, oi.id, oi.id FROM order_items oi JOIN orders o ON o.id=oi.order_id LEFT JOIN tr ON tr.target_id=o.id::text WHERE oi.product_id=$1 AND oi.stock_decremented>0) x),
  st(n,q,avg,k,item_id,cout,couvert) AS (SELECT 0::bigint,0::numeric,NULL::numeric,NULL::int,NULL::uuid,NULL::numeric,NULL::boolean UNION ALL
    SELECT e.n, CASE WHEN e.k=0 THEN s.q+e.qty ELSE greatest(0,s.q-e.qty) END, CASE WHEN e.k=0 THEN CASE WHEN s.q<=0 OR s.avg IS NULL THEN e.cost ELSE (s.q*s.avg+e.qty*e.cost)/(s.q+e.qty) END ELSE s.avg END, e.k, e.item_id, CASE WHEN e.k=1 AND s.q>=e.qty THEN s.avg END, CASE WHEN e.k=1 THEN s.q>=e.qty END FROM st s JOIN ev e ON e.n=s.n+1)
  SELECT item_id, cout, couvert FROM st WHERE k=1`;
async function conforme(p) {
  const attendu = await q(SIM, [p]); const reel = await q(`SELECT order_item_id, cout_cump, couvert FROM cump_sorties WHERE product_id=$1`, [p]);
  if (attendu.length !== reel.length) return false;
  const m = new Map(reel.map(r => [r.order_item_id, r]));
  return attendu.every(a => { const r = m.get(a.item_id); return r && r.couvert === a.couvert && (!a.couvert || Math.abs(Number(r.cout_cump) - Number(a.cout)) < 1e-9); });
}
async function converger() { for (let i = 0; i < 6; i++) { await q(`SELECT cump_traiter_file(200)`); await q(`SELECT cump_detecter_obsoletes()`); const r = await un(`SELECT count(*)::int n FROM cump_file WHERE statut='en_attente'`); if (!r.n) break; } await q(`SELECT cump_traiter_file(200)`); }
const jeu = async () => { const p = await produit(); await rec(p, 100, 8 + (n % 5), '2026-06-15'); await rec(p, 80, 12, '2026-07-10'); await livrer(p, 60, '2026-06-20T05:00:00Z', '2026-06-21T08:00:00Z'); await livrer(p, 90, '2026-07-12T05:00:00Z', '2026-07-12T09:00:00Z'); return p; };

const resultats = []; let ok = true;
const verifier = (nom, cond, detail = '') => { resultats.push(`${cond ? 'OK ' : 'ÉCHEC'}  ${nom}${detail ? '  — ' + detail : ''}`); if (!cond) ok = false; };

// C1 — trois traitements simultanés, 12 produits en attente : chacun traité UNE fois
{
  const ps = []; for (let i = 0; i < 12; i++) ps.push(await jeu());
  const avant = await un(`SELECT count(*)::int n FROM cump_file WHERE statut='en_attente'`);
  const rs = await Promise.all([tache(c => c.query(`SELECT cump_traiter_file(100) r`)), tache(c => c.query(`SELECT cump_traiter_file(100) r`)), tache(c => c.query(`SELECT cump_traiter_file(100) r`))]);
  const total = rs.reduce((s, x) => s + (x.valeur?.rows?.[0]?.r?.reussies ?? 0), 0);
  verifier('C1 trois traitements simultanés, 12 demandes : chacune traitée exactement une fois, aucune erreur ni interblocage', avant.n === 12 && total === 12 && rs.every(x => !x.erreur), `en attente ${avant.n}, réussies ${total}, ${rs.map(x => x.erreur ?? 'ok').join('/')}`);
  const ru = await un(`SELECT count(*) FILTER (WHERE statut='reussi')::int r, count(*) FILTER (WHERE statut='en_attente')::int a, count(*) FILTER (WHERE tentatives<>1)::int t FROM cump_file`);
  verifier('C1 aucune demande en attente, une tentative chacune', ru.r === 12 && ru.a === 0 && ru.t === 0, JSON.stringify(ru));
  let tous = true; for (const p of ps) tous = tous && await conforme(p);
  verifier('C1 résultats identiques à la simulation indépendante pour les 12 produits', tous);
}
// C2 — deux calculs du MÊME produit en même temps : le second attend le premier, aucun doublon
{
  const p = await jeu(); await converger();
  const [a, b] = await Promise.all([tache(c => c.query(`SELECT cump_recalculer_produits(ARRAY['${p}']::uuid[], 'manuel')`), { tenir: 1500 }), tache(c => c.query(`SELECT cump_recalculer_produits(ARRAY['${p}']::uuid[], 'manuel')`), { apres: 300 })]);
  verifier('C2 deux calculs simultanés du même produit : le second attend le verrou du produit puis aboutit', !a.erreur && !b.erreur && b.ms >= 1000, `A ${a.ms} ms, B ${b.ms} ms`);
  const l = await un(`SELECT count(*)::int n, count(DISTINCT order_item_id)::int d FROM cump_sorties WHERE product_id=$1`, [p]);
  verifier('C2 aucune ligne en double, résultat conforme', l.n === l.d && await conforme(p), `${l.n} lignes`);
}
// C3 — une réception est modifiée PENDANT un calcul : elle n'attend jamais plus de 1,5 s, aboutit, et le recalcul se rattrape
{
  const p = await jeu(); await converger(); const r = (await un(`SELECT r.id FROM stock_receptions r JOIN stock_reception_items i ON i.reception_id=r.id WHERE i.product_id=$1 ORDER BY r.received_at LIMIT 1`, [p])).id;
  await q(`SELECT cump_enfiler(ARRAY['${p}']::uuid[], 'reception')`);                                       // une demande en attente, que le traitement va verrouiller
  const [calcul, modif] = await Promise.all([
    tache(c => c.query(`SELECT cump_traiter_file(10) r`), { tenir: 2500 }),                                   // le calcul garde la demande verrouillée 2,5 s (exagération volontaire)
    tache(c => c.query(`SELECT reception_update($1,'F','2026-06-15',NULL,true,$2::jsonb)`, [r, JSON.stringify([{ product_id: p, quantity: 40, unit_cost_ht: 20 }, { product_id: p, quantity: 30, unit_cost_ht: 20 }, { product_id: p, quantity: 30, unit_cost_ht: 20 }])]), { apres: 400 })]);   // 3 lignes : l'attente n'est subie qu'UNE fois
  verifier('C3 modification de réception pendant un calcul : réussie (jamais annulée par le calcul), attente bornée à 1,5 s même avec plusieurs lignes', !modif.erreur && modif.ms < 2200, `réception ${modif.ms} ms, calcul ${calcul.ms} ms, ${modif.erreur ?? 'ok'}`);
  verifier('C3 le coût modifié est bien enregistré', Number((await un(`SELECT unit_cost_ht c FROM stock_reception_items WHERE reception_id=$1`, [r])).c) === 20);
  await converger(); verifier('C3 après rattrapage (demande ou filet de sécurité), les marges correspondent aux nouvelles données', await conforme(p));
}
// C4 — deux rafales d'événements sur le même produit : une seule demande en attente, aucune erreur de doublon
{
  const p = await produit(); await rec(p, 100, 8, '2026-06-15'); await converger();
  const rafale = () => async c => { for (let i = 0; i < 5; i++) await c.query(`SELECT reception_create('F','2026-07-01',NULL,true,$1::jsonb)`, [J(p, 10, 9)]); };
  const [a, b] = await Promise.all([tache(rafale()), tache(rafale())]);
  const f = await un(`SELECT count(*) FILTER (WHERE statut='en_attente')::int a, coalesce(max(evenements),0)::int e FROM cump_file WHERE product_id=$1 AND statut='en_attente'`, [p]);
  verifier('C4 deux rafales simultanées de 5 réceptions : aucune erreur, une seule demande en attente (fusion)', !a.erreur && !b.erreur && f.a === 1, `${a.erreur ?? 'ok'}/${b.erreur ?? 'ok'}, demandes ${f.a}, événements ${f.e}`);
  await converger(); verifier('C4 stock cohérent : 100 + 10 réceptions de 10', (await un(`SELECT stock_quantity s FROM products WHERE id=$1`, [p])).s === 200 && await conforme(p));
}
// C5 — livraison pendant un traitement : aucune perte, convergence
{
  const p = await jeu(); await converger();
  const cmd = (await un(`INSERT INTO orders (status, created_at) VALUES ('livree','2026-07-20T05:00:00Z') RETURNING id`)).id; await q(`INSERT INTO order_items (order_id, product_id, product_name, quantity, price_ht_snapshot, pump_snapshot) VALUES ($1,$2,'x',20,20,10)`, [cmd, p]);
  await q(`SELECT cump_enfiler(ARRAY['${p}']::uuid[], 'livraison')`);
  const [calcul, liv] = await Promise.all([tache(c => c.query(`SELECT cump_traiter_file(10)`), { tenir: 1200 }),
    tache(async c => { await c.query(`SELECT * FROM order_mark_livree($1)`, [cmd]); await c.query(`INSERT INTO admin_audit_logs (admin_email, action, target_type, target_id, details, created_at) VALUES ('a@x.local','commande.statut','order',$1,'{"ancien":"en_attente","nouveau":"livree"}'::jsonb,'2026-07-21T08:00:00Z')`, [cmd]); }, { apres: 300 })]);
  verifier('C5 livraison + trace pendant un calcul : réussie sans erreur', !liv.erreur && !calcul.erreur, `livraison ${liv.ms} ms`);
  await converger(); verifier('C5 après rattrapage : la ligne livrée est valorisée à la date de livraison tracée, tout est conforme', await conforme(p) && (await un(`SELECT source_date s FROM cump_sorties WHERE order_id=$1`, [cmd])).s === 'journal_livraison');
}
// Bilan : rien de bloqué, une seule demande en attente par produit, aucun écart d'empreinte
{
  await converger(); await sleep(300);
  const att = await un(`SELECT count(*)::int n FROM pg_stat_activity WHERE datname='t' AND pid <> pg_backend_pid() AND (wait_event_type='Lock' OR state LIKE 'idle in transaction%')`);
  verifier('Aucun verrou en attente ni transaction oubliée à la fin', att.n === 0);
  const dup = await un(`SELECT count(*)::int n FROM (SELECT product_id FROM cump_file WHERE statut='en_attente' GROUP BY 1 HAVING count(*)>1) x`); verifier('Jamais deux demandes en attente pour un même produit', dup.n === 0);
  verifier('Plus aucune demande en attente ni en échec ; le filet de sécurité ne trouve plus rien à recalculer', (await un(`SELECT count(*)::int n FROM cump_file WHERE statut IN ('en_attente','echoue')`)).n === 0 && (await un(`SELECT cump_detecter_obsoletes() n`)).n === 0);
  const neg = await un(`SELECT count(*)::int n FROM products WHERE stock_quantity < 0`); verifier('Aucun stock négatif', neg.n === 0);
}
console.log('=== CONCURRENCE RÉELLE DU RECALCUL CUMP ==='); console.log(resultats.join('\n')); console.log(ok ? 'TOUT EST CONFORME' : 'AU MOINS UN ÉCHEC');
await adm.end(); await pg.stop();
