/**
 * CUMP glissant — MÉTHODE v2 (supabase/migrations/cump_methode_v2.sql) : réceptions historiques = stock d'ouverture, ajustements manuels de stock, rejeu des vraies données de Bum-Bum.
 * Base locale PGlite (vrai PostgreSQL), vraies migrations du dépôt. Aucune connexion distante.
 */
import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import type { PGlite } from '@electric-sql/pglite';
import { baseAchats, lire, un, exec, produit } from './helpers/receptionsBase';
import { SIMULATION_V2 } from './helpers/cumpOracle';

const M1 = lire('cump_glissant.sql'); const V2 = lire('cump_methode_v2.sql');
let n = 0; const nom = () => `Produit ${++n}`;

async function base(avecV2 = true): Promise<PGlite> { const db = await baseAchats(false); await db.exec(lire('receptions_stock_differentiel.sql')); await db.exec(M1); if (avecV2) await db.exec(V2); return db; }
const rec = async (db: PGlite, p: string, q: number, c: number, date: string, appliquee = true) =>
  (await un(db, `SELECT reception_create('F', $1::date, NULL, $2, $3::jsonb) id`, [date, appliquee, JSON.stringify([{ product_id: p, quantity: q, unit_cost_ht: c }])])).id as string;
async function vente(db: PGlite, p: string, q: number, o: { cree: string; livre?: string | null; snap?: number | null; prix?: number }) {
  const cmd = (await un(db, `INSERT INTO orders (status, created_at) VALUES ('livree', $1::timestamptz) RETURNING id`, [o.cree])).id;
  const it = (await un(db, `INSERT INTO order_items (order_id, product_id, product_name, quantity, price_ht_snapshot, pump_snapshot, stock_decremented) VALUES ($1,$2,'x',$3,$4,$5,$3) RETURNING id`,
    [cmd, p, q, o.prix ?? 20, o.snap === undefined ? 10 : o.snap])).id as string;
  if (o.livre) await db.query(`INSERT INTO admin_audit_logs (admin_email, action, target_type, target_id, details, created_at) VALUES ('a@x.local','commande.statut','order',$1,$2::jsonb,$3::timestamptz)`,
    [cmd, JSON.stringify({ ancien: 'en_attente', nouveau: 'livree' }), o.livre]);
  return it;
}
/** Ajustement manuel de stock tel que l'écrit la page des produits (journal d'audit : cible = identifiant du produit). */
const ajuster = (db: PGlite, p: string, avant: number, apres: number, quand: string) =>
  db.query(`INSERT INTO admin_audit_logs (admin_email, action, target_type, target_id, target_label, details, created_at) SELECT 'a@x.local','produit.stock_ajustement','produit',id::text,name,$2::jsonb,$3::timestamptz FROM products WHERE id=$1`,
    [p, JSON.stringify({ avant, apres, method: 'saisie_directe' }), quand]);
const recalc = async (db: PGlite, ps: string[], decl = 'manuel') => (await un(db, `SELECT cump_recalculer_produits($1::uuid[], $2) r`, [ps, decl])).r;
const ligne = (db: PGlite, it: string) => un(db, `SELECT * FROM cump_sorties WHERE order_item_id=$1`, [it]);
const cout = async (db: PGlite, it: string) => { const l = await ligne(db, it); return l?.cout_cump == null ? null : Number(l.cout_cump); };
const etat = (db: PGlite, p: string) => un(db, `SELECT * FROM cump_etat_produit WHERE product_id=$1`, [p]);
const classes = async (db: PGlite, p: string) => (await exec(db, `SELECT classe, variation FROM cump_ajustements_classes WHERE product_id=$1 ORDER BY date_ajustement`, [p])).map((r: any) => `${r.classe}:${r.variation}`);
const proche = (a: number | null, b: number, tol = 1e-9) => { expect(a).not.toBeNull(); expect(Math.abs((a as number) - b)).toBeLessThan(tol); };
async function empreinte(db: PGlite) {
  const tables = (await exec(db, `SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE' AND table_name NOT LIKE 'cump\\_%' ORDER BY 1`)).map((r: any) => r.table_name as string);
  const out: Record<string, string> = {};
  for (const t of tables) out[t] = (await un(db, `SELECT md5(coalesce(string_agg(to_jsonb(x)::text, ',' ORDER BY to_jsonb(x)::text), '')) h FROM "${t}" x`)).h;
  return out;
}

test.describe('Réceptions historiques = stock d\'ouverture disponible dès l\'origine', () => {
  test('une vente antérieure à la date d\'enregistrement du lot historique est couverte par ce lot, au coût du lot, et classée « estimée » (jamais « fiable ») ; le stock calculé retombe sur le stock affiché', async () => {
    const db = await base();
    try {
      const p = await produit(db, nom(), 12);                                                  // 20 d'ouverture − 8 vendus = 12
      await rec(db, p, 20, 5, '2026-06-30', false);                                             // enregistré le 30/06 comme réception historique
      const avant = await vente(db, p, 8, { cree: '2026-06-23T05:00:00Z', livre: '2026-06-24T08:00:00Z', snap: 5 });   // vendue le 24/06, AVANT la date du lot
      await recalc(db, [p]);
      const l = await ligne(db, avant);
      expect(l.couvert).toBe(true); expect(l.fiabilite).toBe('estimee'); expect(l.motif).toContain('lot_historique_anterieur_a_sa_date'); proche(await cout(db, avant), 5);
      const e = await etat(db, p); expect(e.coherent).toBe(true); expect(e.quantite_calculee).toBe('12'); expect(Number(e.ecart_stock)).toBe(0);
      expect((await un(db, `SELECT stock_quantity s FROM products WHERE id=$1`, [p])).s).toBe(12);   // le stock n'est jamais touché
    } finally { await db.close(); }
  });

  test('une vente postérieure à la date du lot reste « fiable » ; une vente sans lot connu reste « non recalculable » (aucun coût inventé)', async () => {
    const db = await base();
    try {
      const p = await produit(db, nom(), 10); await rec(db, p, 20, 5, '2026-06-30', false);
      const apres = await vente(db, p, 10, { cree: '2026-07-09T05:00:00Z', livre: '2026-07-10T08:00:00Z', snap: 5 });
      const q = await produit(db, nom(), 0); const sans = await vente(db, q, 3, { cree: '2026-06-23T05:00:00Z', livre: '2026-06-24T08:00:00Z', snap: 9 });   // aucun lot connu
      await recalc(db, [p, q]);
      expect((await ligne(db, apres)).fiabilite).toBe('fiable'); expect((await ligne(db, sans)).fiabilite).toBe('non_recalculable'); expect((await ligne(db, sans)).cout_cump).toBeNull();
    } finally { await db.close(); }
  });
});

test.describe('Ajustements manuels de stock : doublons, entrées inconnues, sorties réelles', () => {
  test('doublon d\'une réception historique : ignoré (aucune double valorisation) ; le stock n\'est pas compté deux fois', async () => {
    const db = await base();
    try {
      const p = await produit(db, nom(), 10);
      await rec(db, p, 20, 5, '2026-09-04', false); await ajuster(db, p, 0, 20, '2026-09-07T10:47:00Z');      // même marchandise saisie à la main : 0 → 20
      const v = await vente(db, p, 10, { cree: '2026-09-08T05:00:00Z', livre: '2026-09-09T08:00:00Z', snap: 5 });
      await recalc(db, [p]);
      expect(await classes(db, p)).toEqual(['doublon_reception_historique:20']);
      const e = await etat(db, p); expect(e.quantite_calculee).toBe('10'); expect(e.entrees_inconnues).toBe(0); expect(e.coherent).toBe(true);
      expect((await ligne(db, v)).fiabilite).toBe('fiable'); proche(await cout(db, v), 5);
    } finally { await db.close(); }
  });

  test('entrée de provenance inconnue : jamais valorisée, ne couvre aucune vente, n\'altère pas le coût moyen ; la correction qui la défait est neutre', async () => {
    const db = await base();
    try {
      const p = await produit(db, nom(), 30);                                                   // 10 connus + 20 ajoutés à la main
      await rec(db, p, 10, 8, '2026-07-01'); await ajuster(db, p, 10, 30, '2026-07-05T08:00:00Z');
      const couverte = await vente(db, p, 5, { cree: '2026-07-06T05:00:00Z', livre: '2026-07-06T09:00:00Z', snap: 8 });
      const trop = await vente(db, p, 20, { cree: '2026-07-07T05:00:00Z', livre: '2026-07-07T09:00:00Z', snap: 8 });      // dépasse les 5 unités connues restantes
      await db.query(`UPDATE products SET stock_quantity = 5 WHERE id=$1`, [p]);               // 30 − 25 livrés
      await recalc(db, [p]);
      expect(await classes(db, p)).toEqual(['entree_provenance_inconnue:20']);
      expect((await ligne(db, couverte)).fiabilite).toBe('fiable'); proche(await cout(db, couverte), 8);
      expect((await ligne(db, trop)).fiabilite).toBe('non_recalculable'); expect((await ligne(db, trop)).cout_cump).toBeNull();      // les 20 unités inconnues ne sont jamais valorisées
      const e = await etat(db, p); expect(e.entrees_inconnues).toBe(20);

      const q = await produit(db, nom(), 4); await rec(db, q, 10, 8, '2026-07-01');
      await ajuster(db, q, 10, 31, '2026-07-05T08:00:00Z'); await ajuster(db, q, 31, 10, '2026-07-06T08:00:00Z');         // saisie puis correction : +21 puis −21
      await recalc(db, [q]);
      expect(await classes(db, q)).toEqual(['entree_provenance_inconnue:21', 'correction_annule_entree:-21']);
      const e2 = await etat(db, q); expect(e2.quantite_calculee).toBe('10'); expect(e2.entrees_inconnues).toBe(0);               // neutre : rien n'a bougé
    } finally { await db.close(); }
  });

  test('sortie réelle (perte, casse, régularisation) : retire du stock valorisé au coût moyen, sans ligne de marge ; la cohérence retombe à zéro', async () => {
    const db = await base();
    try {
      const p = await produit(db, nom(), 0); await rec(db, p, 100, 10, '2026-06-15');           // stock 100
      await vente(db, p, 10, { cree: '2026-06-20T05:00:00Z', livre: '2026-06-21T08:00:00Z', snap: 10 });
      await db.query(`UPDATE products SET stock_quantity = 89 WHERE id=$1`, [p]);               // 90 − 1 perdu
      await ajuster(db, p, 90, 89, '2026-06-25T08:00:00Z');
      await recalc(db, [p]);
      expect(await classes(db, p)).toEqual(['sortie_reelle:-1']);
      const e = await etat(db, p); expect(e.quantite_calculee).toBe('89'); expect(e.coherent).toBe(true); expect(Number(e.ecart_stock)).toBe(0);
      expect((await un(db, `SELECT count(*)::int n FROM cump_sorties WHERE product_id=$1`, [p])).n).toBe(1);                      // la perte ne crée aucune ligne de vente
    } finally { await db.close(); }
  });

  test('une sortie réelle pèse sur le coût moyen d\'une réception suivante (le stock valorisé est juste) : 100 à 10 €, perte de 50, puis 50 à 20 € → 15 € et non 13,33 €', async () => {
    const db = await base();
    try {
      const p = await produit(db, nom(), 0); await rec(db, p, 100, 10, '2026-06-15'); await ajuster(db, p, 100, 50, '2026-07-01T08:00:00Z'); await rec(db, p, 50, 20, '2026-07-10');
      const v = await vente(db, p, 10, { cree: '2026-07-19T05:00:00Z', livre: '2026-07-20T08:00:00Z', snap: 12 });
      await recalc(db, [p]);
      expect(await classes(db, p)).toEqual(['sortie_reelle:-50']); proche(await cout(db, v), (50 * 10 + 50 * 20) / 100);
    } finally { await db.close(); }
  });

  test('baisse partiellement absorbée : la part qui défait une entrée inconnue est neutre, le reste est une sortie réelle', async () => {
    const db = await base();
    try {
      const p = await produit(db, nom(), 0); await rec(db, p, 100, 10, '2026-06-15');
      await ajuster(db, p, 100, 130, '2026-07-01T08:00:00Z'); await ajuster(db, p, 130, 80, '2026-07-02T08:00:00Z');          // +30 inconnus, puis −50 : 30 défont l'entrée, 20 sont perdus
      await db.query(`UPDATE products SET stock_quantity = 80 WHERE id=$1`, [p]);
      await recalc(db, [p]);
      expect(await classes(db, p)).toEqual(['entree_provenance_inconnue:30', 'sortie_reelle_apres_annulation_entree:-50']);
      const e = await etat(db, p); expect(e.quantite_calculee).toBe('80'); expect(e.entrees_inconnues).toBe(0); expect(e.coherent).toBe(true);
    } finally { await db.close(); }
  });
});

test.describe('Mise à niveau v1 → v2 sur une base déjà remplie', () => {
  test('les coûts d\'origine sont conservés, les lignes sont recalculées en version 2, la mise à niveau est rejouable, les droits sont ceux du serveur seul', async () => {
    const db = await base(false);
    try {
      const p = await produit(db, nom(), 12); await rec(db, p, 20, 5, '2026-06-30', false);
      const v1 = await vente(db, p, 8, { cree: '2026-06-23T05:00:00Z', livre: '2026-06-24T08:00:00Z', snap: 5.5 });
      await recalc(db, [p], 'initial');
      expect((await ligne(db, v1)).fiabilite).toBe('non_recalculable'); expect((await ligne(db, v1)).version_methode).toBe(1);       // v1 : lot daté du 30/06, vente du 24/06 non couverte
      await db.exec(V2); await db.exec(V2);                                                                                         // mise à niveau, deux fois
      await recalc(db, [p]);
      const l = await ligne(db, v1); expect(l.fiabilite).toBe('estimee'); expect(l.version_methode).toBe(2); proche(await cout(db, v1), 5);
      expect(Number(l.cout_initial)).toBe(5.5);                                                                                     // coût d'origine inchangé
      expect((await un(db, `SELECT count(*)::int n FROM cump_sorties`)).n).toBe(1);
      for (const role of ['anon', 'authenticated']) { await db.exec(`SET ROLE ${role}`); for (const q of [`SELECT * FROM cump_ajustements_classes`, `SELECT * FROM cump_ledger('${p}')`]) expect(await db.query(q).then(() => '', e => e.message), `${role} ${q}`).toMatch(/permission denied/); await db.exec('RESET ROLE'); }
      const f = await exec(db, `SELECT proname, prosecdef, proconfig::text c, proacl::text a FROM pg_proc WHERE proname IN ('cump_ledger','cump_recalculer_produits','cump_empreintes')`);
      expect(f).toHaveLength(3); for (const x of f) { expect(x.prosecdef).toBe(false); expect(x.c).toContain('search_path'); expect(x.a).not.toMatch(/anon|authenticated|(^\{|,)=X/); }
    } finally { await db.close(); }
  });

  test('la mise à niveau n\'altère aucun objet hors cump_* : mêmes fonctions, tables, colonnes, déclencheurs et droits', async () => {
    const db = await base(false);
    try {
      const objets = async () => ({
        f: await exec(db, `SELECT proname, md5(pg_get_functiondef(oid)) m, proacl::text a FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname NOT LIKE 'cump\\_%' ORDER BY 1,2`),
        t: (await exec(db, `SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name NOT LIKE 'cump\\_%' ORDER BY 1`)).map((r: any) => r.table_name),
        c: (await un(db, `SELECT md5(string_agg(table_name||'.'||column_name||':'||data_type, ',' ORDER BY table_name, column_name)) h FROM information_schema.columns WHERE table_schema='public' AND table_name NOT LIKE 'cump\\_%'`)).h,
        d: await exec(db, `SELECT tgname FROM pg_trigger WHERE NOT tgisinternal AND tgname NOT LIKE '%cump%' ORDER BY 1`),
      });
      const avant = await objets(); await db.exec(V2); expect(await objets()).toEqual(avant);
    } finally { await db.close(); }
  });
});

test.describe('Comparaison avec l\'implémentation indépendante (méthode v2)', () => {
  function alea(graine: number) { let a = graine; return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
  for (const graine of [3, 11, 99]) {
    test(`jeu aléatoire n° ${graine} : réceptions appliquées et historiques, ventes tracées ou non, ajustements manuels de toute nature — coût et couverture identiques ligne à ligne`, async () => {
      const db = await base(); const hasard = alea(graine); const entre = (a: number, b: number) => a + Math.floor(hasard() * (b - a + 1));
      const jour = (d: number) => new Date(Date.UTC(2026, 5, 1) + d * 86400000).toISOString();
      try {
        let lignes = 0, adjs = 0;
        for (let k = 0; k < 8; k++) {
          const p = await produit(db, nom(), entre(0, 80));
          const hist: number[] = [];
          for (let i = 0, nr = entre(2, 5); i < nr; i++) { const h = hasard() < 0.35; const q = entre(10, 90); if (h) hist.push(q); await rec(db, p, q, entre(500, 2000) / 100, jour(entre(5, 140)).slice(0, 10), !h); }
          for (let i = 0, nv = entre(8, 16); i < nv; i++) { const cree = entre(2, 150); await vente(db, p, entre(1, 30), { cree: jour(cree), livre: hasard() > 0.15 ? jour(cree + entre(0, 6)) : null, snap: entre(500, 2000) / 100, prix: 25 }); }
          for (let i = 0, na = entre(0, 4); i < na; i++) {                                                                                   // ajustements : doublon, entrée inconnue, baisse
            const t = jour(entre(10, 150)); const typ = entre(0, 2); adjs++;
            if (typ === 0 && hist.length) await ajuster(db, p, 0, hist[0], t); else if (typ === 1) await ajuster(db, p, entre(5, 20), entre(21, 60), t); else await ajuster(db, p, entre(30, 60), entre(0, 29), t);
          }
          await recalc(db, [p]);
          const attendu = await exec(db, SIMULATION_V2, [p]);
          for (const a of attendu) { const l = await ligne(db, a.item_id); lignes++; expect(l.couvert, `couverture ${a.item_id}`).toBe(a.couvert); if (a.couvert) proche(await cout(db, a.item_id), Number(a.cout)); else expect(l.cout_cump).toBeNull(); }
          expect((await un(db, `SELECT count(*)::int n FROM cump_sorties WHERE product_id=$1`, [p])).n).toBe(attendu.length);
        }
        expect(lignes).toBeGreaterThan(50); expect(adjs).toBeGreaterThan(5);
      } finally { await db.close(); }
    });
  }
});

test.describe('Rejeu des vraies données de Bum-Bum Pêche x24 (relevé de production du 19 novembre, aucune donnée client)', () => {
  const reel = JSON.parse(readFileSync('tests/fixtures/bumbum-reel.json', 'utf8')) as { receptions: { date: string; qte: number; cout: number }[]; ventes: { cree: string; livre: string; q: number; prix: number; snap: number }[] };

  test('le moteur retrouve les résultats de la simulation : 28 lignes fiables, marge 2 508,47 € → 2 845,56 €, coût moyen final 8,2122 €', async () => {
    const db = await base();
    try {
      const p = await produit(db, 'Bum-Bum Pêche *24', 0); const rs: string[] = []; for (const r of reel.receptions) rs.push(await rec(db, p, r.qte, r.cout, r.date));
      const its: string[] = [];
      for (const v of reel.ventes) {                                                                                   // livraison par la VRAIE fonction : le stock est déduit comme en production
        const cmd = (await un(db, `INSERT INTO orders (status, created_at) VALUES ('en_attente', $1::timestamptz) RETURNING id`, [v.cree])).id;
        its.push((await un(db, `INSERT INTO order_items (order_id, product_id, product_name, quantity, price_ht_snapshot, pump_snapshot) VALUES ($1,$2,'Bum-Bum',$3,$4,$5) RETURNING id`, [cmd, p, v.q, v.prix, v.snap])).id);
        await db.query(`UPDATE orders SET status='livree' WHERE id=$1`, [cmd]); await db.query(`SELECT * FROM order_mark_livree($1)`, [cmd]);
        await db.query(`INSERT INTO admin_audit_logs (admin_email, action, target_type, target_id, details, created_at) VALUES ('a@x.local','commande.statut','order',$1,'{"ancien":"en_attente","nouveau":"livree"}'::jsonb,$2::timestamptz)`, [cmd, v.livre]);
      }
      expect((await un(db, `SELECT stock_quantity s FROM products WHERE id=$1`, [p])).s).toBe(30);                      // 360 reçus − 330 livrés
      await recalc(db, [p], 'initial');
      const marges = await un(db, `SELECT round(sum((oi.price_ht_snapshot-oi.pump_snapshot)*oi.quantity),2) a, round(sum((oi.price_ht_snapshot-c.cout_cump)*oi.quantity),2) r, count(*) FILTER (WHERE c.fiabilite='fiable')::int f, count(*)::int n
                                FROM cump_sorties c JOIN order_items oi ON oi.id=c.order_item_id WHERE c.product_id=$1`, [p]);
      expect(marges).toMatchObject({ a: '2508.47', r: '2845.56', f: 28, n: 28 });
      proche(Number((await etat(db, p)).cump_courant), 8.2122, 5e-5); expect((await etat(db, p)).coherent).toBe(true);
      void its; void rs;
    } finally { await db.close(); }
  });

  test('corriger le coût de la réception du 28/10 (7,92 → 9,00) : seules les 9 ventes livrées APRÈS elle sont recalculées ; quantités, prix, stocks, commandes, pump_snapshot, factures intacts ; retour à 7,92 = résultats initiaux', async () => {
    const db = await base();
    try {
      const p = await produit(db, 'Bum-Bum Pêche *24', 0); const rs: string[] = []; for (const r of reel.receptions) rs.push(await rec(db, p, r.qte, r.cout, r.date));
      for (const v of reel.ventes) {
        const cmd = (await un(db, `INSERT INTO orders (status, created_at) VALUES ('en_attente', $1::timestamptz) RETURNING id`, [v.cree])).id;
        await db.query(`INSERT INTO order_items (order_id, product_id, product_name, quantity, price_ht_snapshot, pump_snapshot) VALUES ($1,$2,'Bum-Bum',$3,$4,$5)`, [cmd, p, v.q, v.prix, v.snap]);
        await db.query(`UPDATE orders SET status='livree' WHERE id=$1`, [cmd]); await db.query(`SELECT * FROM order_mark_livree($1)`, [cmd]);
        await db.query(`INSERT INTO admin_audit_logs (admin_email, action, target_type, target_id, details, created_at) VALUES ('a@x.local','commande.statut','order',$1,'{"ancien":"en_attente","nouveau":"livree"}'::jsonb,$2::timestamptz)`, [cmd, v.livre]);
      }
      await recalc(db, [p], 'initial');
      const initial = await exec(db, `SELECT order_item_id, cout_cump FROM cump_sorties WHERE product_id=$1 ORDER BY order_item_id`, [p]);
      const total = async () => (await un(db, `SELECT round(sum((oi.price_ht_snapshot-c.cout_cump)*oi.quantity),2) r FROM cump_sorties c JOIN order_items oi ON oi.id=c.order_item_id WHERE c.product_id=$1`, [p])).r;
      expect(await total()).toBe('2845.56');

      const stock = (await un(db, `SELECT stock_quantity s FROM products WHERE id=$1`, [p])).s; const avantFixe = await empreinte(db);
      const stocksEtPrix = await un(db, `SELECT md5(string_agg(id || ':' || stock_quantity || ':' || in_stock || ':' || coalesce(price_ht::text,'-') || ':' || name, ',' ORDER BY id)) h FROM products`);
      await db.query(`SELECT reception_update($1,'F','2026-10-28',NULL,true,$2::jsonb)`, [rs[2], JSON.stringify([{ product_id: p, quantity: 120, unit_cost_ht: 9 }])]);        // correction du coût : prix seul
      expect((await un(db, `SELECT stock_quantity s FROM products WHERE id=$1`, [p])).s).toBe(stock);                                                                            // aucune variation de stock
      const j = await recalc(db, [p], 'reception_modification');
      expect(j.modifiees).toBe(9);
      const apres = await exec(db, `SELECT order_item_id, cout_cump FROM cump_sorties WHERE product_id=$1 ORDER BY order_item_id`, [p]);
      const changees = apres.filter((x: any, i: number) => Math.abs(Number(x.cout_cump) - Number(initial[i].cout_cump)) > 1e-9).length; expect(changees).toBe(9);                  // exactement les ventes postérieures
      const [moins] = (await exec(db, SIMULATION_V2, [p])).slice(0, 1); expect(moins).toBeTruthy();
      for (const a of await exec(db, SIMULATION_V2, [p])) proche(await cout(db, a.item_id), Number(a.cout));                                                                    // conforme à l'implémentation indépendante
      expect(Number(await total())).toBeLessThan(2845.56);                                                                                                                         // coût plus élevé : marge plus basse
      const fixeApres = await empreinte(db);
      for (const t of ['products', 'orders', 'order_items', 'admin_audit_logs']) expect(fixeApres[t], `${t} inchangé par le recalcul`).toBe((await empreinte(db))[t]);
      expect(avantFixe['order_items']).toBe(fixeApres['order_items']);                                                                                                             // quantités, prix de vente, pump_snapshot : identiques
      expect(stocksEtPrix).toEqual(await un(db, `SELECT md5(string_agg(id || ':' || stock_quantity || ':' || in_stock || ':' || coalesce(price_ht::text,'-') || ':' || name, ',' ORDER BY id)) h FROM products`));   // stocks et prix de vente des produits
      expect(avantFixe['orders']).toBe(fixeApres['orders']);                                                            // stocks, commandes, factures : identiques
      expect((await un(db, `SELECT cout_initial c FROM cump_sorties WHERE order_item_id = $1`, [apres[apres.length - 1].order_item_id])).c).not.toBeNull();                       // coûts d'origine conservés

      await db.query(`SELECT reception_update($1,'F','2026-10-28',NULL,true,$2::jsonb)`, [rs[2], JSON.stringify([{ product_id: p, quantity: 120, unit_cost_ht: 7.92 }])]);        // retour à la valeur initiale
      await recalc(db, [p], 'reception_modification');
      expect(await total()).toBe('2845.56');
      expect(await exec(db, `SELECT order_item_id, cout_cump FROM cump_sorties WHERE product_id=$1 ORDER BY order_item_id`, [p])).toEqual(initial);
    } finally { await db.close(); }
  });
});
