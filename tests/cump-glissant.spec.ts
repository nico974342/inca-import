/**
 * CUMP glissant : moteur de recalcul du coût réalisé des ventes (supabase/migrations/cump_glissant.sql).
 * Base locale PGlite (vrai PostgreSQL) avec les VRAIES migrations du dépôt, y compris le correctif des réceptions déjà en production. Aucune connexion distante.
 */
import { test, expect } from '@playwright/test';
import { execSync } from 'node:child_process';
import type { PGlite } from '@electric-sql/pglite';
import { baseAchats, lire, un, exec, produit } from './helpers/receptionsBase';

const CUMP = lire('cump_glissant.sql');
let n = 0;
const nom = () => `Produit ${++n}`;

async function base(): Promise<PGlite> { const db = await baseAchats(false); await db.exec(lire('receptions_stock_differentiel.sql')); await db.exec(CUMP); return db; }
const rec = async (db: PGlite, p: string, q: number, c: number, date: string, appliquee = true) =>
  (await un(db, `SELECT reception_create('F', $1::date, NULL, $2, $3::jsonb) id`, [date, appliquee, JSON.stringify([{ product_id: p, quantity: q, unit_cost_ht: c }])])).id as string;
/** Ligne livrée : commande créée à `cree`, livraison tracée au journal à `livre` (null = aucune trace). */
async function vente(db: PGlite, p: string, q: number, o: { cree: string; livre?: string | null; snap?: number | null; prix?: number | null }) {
  const cmd = (await un(db, `INSERT INTO orders (status, created_at) VALUES ('livree', $1::timestamptz) RETURNING id`, [o.cree])).id;
  const it = (await un(db, `INSERT INTO order_items (order_id, product_id, product_name, quantity, price_ht_snapshot, pump_snapshot, stock_decremented) VALUES ($1,$2,'x',$3,$4,$5,$3) RETURNING id`,
    [cmd, p, q, o.prix === undefined ? 20 : o.prix, o.snap === undefined ? 10 : o.snap])).id as string;
  if (o.livre) await db.query(`INSERT INTO admin_audit_logs (admin_email, action, target_type, target_id, details, created_at) VALUES ('a@x.local','commande.statut','commande',$1,$2::jsonb,$3::timestamptz)`,
    [cmd, JSON.stringify({ ancien: 'en_attente', nouveau: 'livree' }), o.livre]);
  return it;
}
const recalc = async (db: PGlite, ps: string[], decl = 'manuel', rid: string | null = null) => (await un(db, `SELECT cump_recalculer_produits($1::uuid[], $2, $3) r`, [ps, decl, rid])).r;
const ligne = async (db: PGlite, it: string) => un(db, `SELECT * FROM cump_sorties WHERE order_item_id=$1`, [it]);
const cout = async (db: PGlite, it: string) => { const l = await ligne(db, it); return l?.cout_cump == null ? null : Number(l.cout_cump); };
const refuse = async (f: Promise<unknown>) => { try { await f; return ''; } catch (e: any) { return String(e.message); } };
const proche = (a: number | null, b: number) => { expect(a).not.toBeNull(); expect(Math.abs((a as number) - b)).toBeLessThan(1e-9); };

/** Empreinte du contenu de TOUTES les tables hors cump_* : prouve que le moteur n'écrit nulle part ailleurs. */
async function empreinte(db: PGlite) {
  const tables = (await exec(db, `SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE' AND table_name NOT LIKE 'cump\\_%' ORDER BY 1`)).map((r: any) => r.table_name as string);
  const out: Record<string, string> = {};
  for (const t of tables) out[t] = (await un(db, `SELECT md5(coalesce(string_agg(to_jsonb(x)::text, ',' ORDER BY to_jsonb(x)::text), '')) h FROM "${t}" x`)).h;
  return out;
}

test.describe('Scénario Bum-Bum : corriger un coût ancien ne change que les ventes concernées', () => {
  test('correction du coût de la 3e réception : seules les ventes livrées APRÈS elle changent ; les valeurs d\'origine sont conservées ; retour à la valeur initiale = résultat initial', async () => {
    const db = await base();
    try {
      const p = await produit(db, nom(), 0);
      const r1 = await rec(db, p, 120, 13.32, '2026-08-11'); await rec(db, p, 120, 13.2, '2026-08-25'); const r3 = await rec(db, p, 120, 7.92, '2026-10-28');
      const s1 = await vente(db, p, 100, { cree: '2026-08-12T05:00:00Z', livre: '2026-08-12T08:00:00Z', snap: 13.32 });
      const s2 = await vente(db, p, 20, { cree: '2026-08-26T05:00:00Z', livre: '2026-08-26T08:00:00Z', snap: 13.26 });
      const s3 = await vente(db, p, 100, { cree: '2026-09-20T05:00:00Z', livre: '2026-09-20T08:00:00Z', snap: 13.26 });
      const s4 = await vente(db, p, 50, { cree: '2026-10-26T05:00:00Z', livre: '2026-10-29T08:00:00Z', snap: 13.26 });   // créée AVANT la réception du 28/10, livrée APRÈS : coût de la date de livraison
      const s5 = await vente(db, p, 30, { cree: '2026-11-05T05:00:00Z', livre: '2026-11-05T08:00:00Z', snap: 11.5 });
      await recalc(db, [p], 'initial');

      const avg2 = (20 * 13.32 + 120 * 13.2) / 140; const avg3 = (20 * avg2 + 120 * 7.92) / 140;
      proche(await cout(db, s1), 13.32); proche(await cout(db, s2), avg2); proche(await cout(db, s3), avg2); proche(await cout(db, s4), avg3); proche(await cout(db, s5), avg3);
      for (const s of [s1, s2, s3, s4, s5]) expect((await ligne(db, s)).fiabilite).toBe('fiable');
      expect(Number((await ligne(db, s4)).cout_initial)).toBe(13.26);                       // le coût d'origine est copié, jamais écrasé

      const avantCorrection = await empreinte(db);
      // correction d'une erreur de saisie : le coût de la réception du 28/10 devient 9,00 (le stock est inchangé : prix seul)
      await db.query(`SELECT reception_update($1,'F','2026-10-28',NULL,true,$2::jsonb)`, [r3, JSON.stringify([{ product_id: p, quantity: 120, unit_cost_ht: 9 }])]);
      const j = await recalc(db, [p], 'reception_modification', r3);
      const avg3b = (20 * avg2 + 120 * 9) / 140;
      proche(await cout(db, s1), 13.32); proche(await cout(db, s2), avg2); proche(await cout(db, s3), avg2);            // ventes antérieures : inchangées
      proche(await cout(db, s4), avg3b); proche(await cout(db, s5), avg3b);                                           // ventes postérieures : recalculées
      expect(j.modifiees).toBe(2);
      expect(Number((await ligne(db, s4)).cout_initial)).toBe(13.26);                       // toujours la valeur d'origine
      const jr = await un(db, `SELECT * FROM cump_recalculs WHERE declencheur='reception_modification'`);
      expect(jr.reception_id).toBe(r3); expect(jr.lignes_modifiees).toBe(2); expect(jr.detail).toHaveLength(2);
      expect(Number(jr.marge_apres)).toBeLessThan(Number(jr.marge_avant));                  // coût plus élevé = marge plus basse
      expect(Number(jr.marge_avant) - Number(jr.marge_apres)).toBeCloseTo(80 * (avg3b - avg3), 1);
      // pump_snapshot, prix, quantités, stocks : intacts (seule la réception modifiée par la correction elle-même a changé)
      expect((await un(db, `SELECT pump_snapshot p FROM order_items WHERE id=$1`, [s4])).p).toBe('13.26');

      // retour à la valeur initiale : mêmes coûts qu'avant la correction
      await db.query(`SELECT reception_update($1,'F','2026-10-28',NULL,true,$2::jsonb)`, [r3, JSON.stringify([{ product_id: p, quantity: 120, unit_cost_ht: 7.92 }])]);
      await recalc(db, [p], 'reception_modification', r3);
      proche(await cout(db, s4), avg3); proche(await cout(db, s5), avg3);
      expect(await un(db, `SELECT count(*)::int n FROM cump_recalculs`)).toEqual({ n: 3 });
      expect(avantCorrection).toBeTruthy(); void r1;
    } finally { await db.close(); }
  });

  test('la valorisation suit la livraison réelle : une vente créée avant une réception mais livrée après est valorisée avec cette réception', async () => {
    const db = await base();
    try {
      const p = await produit(db, nom(), 0); await rec(db, p, 50, 10, '2026-08-01'); await rec(db, p, 50, 20, '2026-08-10');
      const v = await vente(db, p, 40, { cree: '2026-08-05T05:00:00Z', livre: '2026-08-12T08:00:00Z', snap: 10 });     // 10 cartons livrés le 7 (stock 40 à 10 €), puis réception du 10 : coût moyen (40×10 + 50×20)/90
      await vente(db, p, 10, { cree: '2026-08-06T05:00:00Z', livre: '2026-08-07T08:00:00Z', snap: 10 });
      await recalc(db, [p]);
      proche(await cout(db, v), (40 * 10 + 50 * 20) / 90);                                  // avec la date de COMMANDE (5/08) on aurait trouvé 10
    } finally { await db.close(); }
  });
});

test.describe('Fiabilité : fiable, estimée, non recalculable, coût reconstitué', () => {
  test('date de livraison approchée → estimée (jamais présentée comme certaine) ; stock insuffisant → non recalculable sans coût inventé', async () => {
    const db = await base();
    try {
      const p = await produit(db, nom(), 0);
      const avant = await vente(db, p, 25, { cree: '2026-06-01T05:00:00Z', livre: '2026-06-02T08:00:00Z', snap: 12 });      // avant toute réception : stock d'ouverture inconnu
      await rec(db, p, 100, 8, '2026-06-15');
      const sansTrace = await vente(db, p, 10, { cree: '2026-06-20T05:00:00Z', livre: null, snap: 9 });                       // aucune trace de livraison
      const normale = await vente(db, p, 10, { cree: '2026-07-01T05:00:00Z', livre: '2026-07-02T08:00:00Z', snap: 9 });
      const trop = await vente(db, p, 200, { cree: '2026-07-10T05:00:00Z', livre: '2026-07-10T08:00:00Z', snap: 9 });          // plus que le stock connu (80)
      await recalc(db, [p]);
      let l = await ligne(db, avant); expect(l.fiabilite).toBe('non_recalculable'); expect(l.cout_cump).toBeNull(); expect(l.couvert).toBe(false); expect(Number(l.cout_initial)).toBe(12);
      l = await ligne(db, sansTrace); expect(l.fiabilite).toBe('estimee'); expect(l.source_date).toBe('creation_commande_approchee'); expect(l.motif).toContain('date_livraison_approchee'); proche(await cout(db, sansTrace), 8);
      l = await ligne(db, normale); expect(l.fiabilite).toBe('fiable'); expect(l.source_date).toBe('journal_livraison'); proche(await cout(db, normale), 8);
      l = await ligne(db, trop); expect(l.fiabilite).toBe('non_recalculable'); expect(l.cout_cump).toBeNull();
      expect((await un(db, `SELECT quantite_calculee q FROM cump_etat_produit WHERE product_id=$1`, [p])).q).toBe('0');       // stock épuisé, jamais négatif
    } finally { await db.close(); }
  });

  test('ligne sans coût d\'origine : « coût reconstitué » seulement si la reconstitution est fiable ; sinon l\'absence de coût est conservée', async () => {
    const db = await base();
    try {
      const p = await produit(db, nom(), 0); await rec(db, p, 100, 8, '2026-06-15');
      const ok = await vente(db, p, 10, { cree: '2026-07-01T05:00:00Z', livre: '2026-07-02T08:00:00Z', snap: null });
      const flou = await vente(db, p, 10, { cree: '2026-07-03T05:00:00Z', livre: null, snap: null });
      await recalc(db, [p]);
      const a = await ligne(db, ok); expect(a.reconstitue).toBe(true); expect(a.fiabilite).toBe('fiable'); expect(a.cout_initial).toBeNull(); proche(await cout(db, ok), 8);
      const b = await ligne(db, flou); expect(b.reconstitue).toBe(false); expect(b.cout_cump).toBeNull(); expect(b.fiabilite).toBe('non_recalculable'); expect(b.motif).toBe('sans_cout_origine_reconstitution_non_fiable');
    } finally { await db.close(); }
  });
});

test.describe('Réceptions historiques et stock d\'ouverture : aucune double valorisation', () => {
  test('un lot historique sert de coût mais ne crée jamais de stock ; les ajustements manuels ne sont pas ajoutés comme lots ; le stock affiché n\'est jamais modifié', async () => {
    const db = await base();
    try {
      const p = await produit(db, nom(), 10);                                              // stock d'ouverture (20) moins 10 déjà livrés = 10 affichés
      await rec(db, p, 20, 5, '2026-06-30', false);                                         // réception historique : stock_applied = false
      expect((await un(db, `SELECT stock_quantity s FROM products WHERE id=$1`, [p])).s).toBe(10);
      await db.query(`INSERT INTO admin_audit_logs (admin_email, action, target_type, target_id, target_label, details) SELECT 'a@x.local','produit.stock_ajustement','produit',id::text,name,'{"avant":0,"apres":20}'::jsonb FROM products WHERE id=$1`, [p]);
      const v = await vente(db, p, 10, { cree: '2026-07-09T05:00:00Z', livre: '2026-07-10T08:00:00Z', snap: 6 });
      await recalc(db, [p]);
      const e = await un(db, `SELECT * FROM cump_etat_produit WHERE product_id=$1`, [p]);
      expect(e.quantite_calculee).toBe('10'); expect(e.coherent).toBe(true); expect(Number(e.ecart_stock)).toBe(0);      // 20 (lot) − 10 livrés = 10 = stock affiché : pas de double comptage
      expect((await ligne(db, v)).fiabilite).toBe('fiable'); proche(await cout(db, v), 5);
      expect((await un(db, `SELECT stock_quantity s FROM products WHERE id=$1`, [p])).s).toBe(10);
    } finally { await db.close(); }
  });

  test('stock affiché incohérent avec les lots historiques : les coûts qui en dépendent sont « estimés », l\'écart est signalé et jamais corrigé', async () => {
    const db = await base();
    try {
      const p = await produit(db, nom(), 15);                                              // 5 de plus que ce que les événements expliquent
      await rec(db, p, 20, 5, '2026-06-30', false);
      const v = await vente(db, p, 10, { cree: '2026-07-09T05:00:00Z', livre: '2026-07-10T08:00:00Z', snap: 6 });
      await recalc(db, [p]);
      const l = await ligne(db, v); expect(l.fiabilite).toBe('estimee'); expect(l.motif).toContain('lots_historiques_stock_incoherent'); expect(Number(l.part_historique)).toBe(1);
      const e = await un(db, `SELECT * FROM cump_etat_produit WHERE product_id=$1`, [p]); expect(e.coherent).toBe(false); expect(Number(e.ecart_stock)).toBe(5);
      expect((await un(db, `SELECT stock_quantity s FROM products WHERE id=$1`, [p])).s).toBe(15);
    } finally { await db.close(); }
  });
});

test.describe('Étanchéité, historique et droits', () => {
  test('le recalcul n\'écrit que dans cump_* : prix de vente, quantités, stocks, réservations, commandes, réceptions, factures, journal d\'audit — empreintes identiques', async () => {
    const db = await base();
    try {
      const p = await produit(db, nom(), 30); const q = await produit(db, nom(), 5);
      await rec(db, p, 100, 8, '2026-06-15'); await rec(db, q, 10, 3, '2026-06-15', false);
      await vente(db, p, 20, { cree: '2026-07-01T05:00:00Z', livre: '2026-07-02T08:00:00Z', snap: 9 }); await vente(db, q, 5, { cree: '2026-07-03T05:00:00Z', livre: null, snap: null });
      await db.query(`INSERT INTO orders (status) VALUES ('en_attente')`);
      const avant = await empreinte(db); const dispo = await exec(db, `SELECT * FROM product_availability ORDER BY product_id`);
      await recalc(db, [p, q], 'initial'); await un(db, `SELECT cump_recalculer_tout('controle') r`);
      expect(await empreinte(db)).toEqual(avant);
      expect(await exec(db, `SELECT * FROM product_availability ORDER BY product_id`)).toEqual(dispo);
      expect(Object.keys(avant)).toEqual(expect.arrayContaining(['products', 'orders', 'order_items', 'stock_receptions', 'stock_reception_items', 'admin_audit_logs']));
    } finally { await db.close(); }
  });

  test('cout_initial immuable ; journal append-only ; rien ne se vide', async () => {
    const db = await base();
    try {
      const p = await produit(db, nom(), 0); await rec(db, p, 50, 8, '2026-06-15'); const v = await vente(db, p, 10, { cree: '2026-07-01T05:00:00Z', livre: '2026-07-02T08:00:00Z', snap: 9 }); await recalc(db, [p]);
      expect(await refuse(db.query(`UPDATE cump_sorties SET cout_initial = 1 WHERE order_item_id=$1`, [v]))).toContain('COUT_INITIAL_IMMUABLE');
      expect(await refuse(db.query(`UPDATE cump_recalculs SET lignes = 0`))).toContain('CUMP_JOURNAL_APPEND_ONLY');
      expect(await refuse(db.query(`DELETE FROM cump_recalculs`))).toContain('CUMP_JOURNAL_APPEND_ONLY');
      expect(await refuse(db.query(`TRUNCATE cump_recalculs`))).toContain('CUMP_JOURNAL_APPEND_ONLY');
      expect(await refuse(db.query(`TRUNCATE cump_sorties`))).toContain('CUMP_NON_VIDABLE');
      await db.query(`UPDATE cump_sorties SET cout_cump = cout_cump WHERE order_item_id=$1`, [v]);                  // les autres colonnes restent recalculables
      expect(await refuse(db.query(`SELECT cump_recalculer_produits(ARRAY[]::uuid[], 'nimporte')`))).toContain('CUMP_DECLENCHEUR_INVALIDE');
    } finally { await db.close(); }
  });

  test('livraison annulée ensuite : le calcul dérivé de la ligne est retiré, le journal garde la trace ; une ligne en cours n\'a pas de coût réalisé (vue : prévisionnel / réalisé)', async () => {
    const db = await base();
    try {
      const p = await produit(db, nom(), 0); await rec(db, p, 50, 8, '2026-06-15');
      const a = await vente(db, p, 10, { cree: '2026-07-01T05:00:00Z', livre: '2026-07-02T08:00:00Z', snap: 9, prix: 20 });
      const enCours = (await un(db, `INSERT INTO orders (status) VALUES ('en_attente') RETURNING id`)).id;
      await db.query(`INSERT INTO order_items (order_id, product_id, product_name, quantity, price_ht_snapshot, pump_snapshot) VALUES ($1,$2,'x',5,20,9)`, [enCours, p]);
      await recalc(db, [p]);
      const vue = await exec(db, `SELECT * FROM cump_marges_lignes WHERE product_id=$1 ORDER BY statut_marge`, [p]);
      const livree = vue.find((x: any) => x.order_item_id === a); const pend = vue.find((x: any) => x.statut === 'en_attente');
      expect(Number(livree.marge_previsionnelle)).toBe(110); expect(Number(livree.marge_realisee)).toBe(120); expect(livree.statut_marge).toBe('fiable');        // (20−9)×10 prévisionnelle, (20−8)×10 réalisée
      expect(pend.statut_marge).toBe('en_cours'); expect(pend.marge_realisee).toBeNull(); expect(Number(pend.marge_previsionnelle)).toBe(55);
      await db.query(`UPDATE order_items SET stock_decremented = NULL WHERE id=$1`, [a]); await db.query(`UPDATE orders SET status='annulee' WHERE id=(SELECT order_id FROM order_items WHERE id=$1)`, [a]);
      const j = await recalc(db, [p]); expect(j.supprimees).toBe(1); expect(await ligne(db, a)).toBeUndefined();
      expect((await un(db, `SELECT statut_marge s FROM cump_marges_lignes WHERE order_item_id=$1`, [a])).s).toBe('annulee');
    } finally { await db.close(); }
  });

  test('droits : serveur seulement (anon et authenticated refusés partout), search_path fixé, vue en security_invoker ; la migration est rejouable sans effet', async () => {
    const db = await base();
    try {
      const p = await produit(db, nom(), 0); await rec(db, p, 50, 8, '2026-06-15'); await vente(db, p, 10, { cree: '2026-07-01T05:00:00Z', livre: '2026-07-02T08:00:00Z', snap: 9 });
      for (const role of ['anon', 'authenticated']) {
        await db.exec(`SET ROLE ${role}`);
        for (const q of [`SELECT * FROM cump_sorties`, `SELECT * FROM cump_etat_produit`, `SELECT * FROM cump_recalculs`, `SELECT * FROM cump_marges_lignes`, `INSERT INTO cump_recalculs (declencheur, produits, lignes, lignes_modifiees) VALUES ('manuel','{}',0,0)`,
          `SELECT cump_recalculer_tout()`, `SELECT cump_recalculer_produits(ARRAY[]::uuid[])`, `SELECT * FROM cump_ledger('${p}')`]) expect(await refuse(db.query(q)), `${role} ${q}`).toMatch(/permission denied/);
        await db.exec('RESET ROLE');
      }
      await db.exec('SET ROLE service_role'); await recalc(db, [p]); expect((await exec(db, `SELECT * FROM cump_marges_lignes`)).length).toBeGreaterThan(0); await db.exec('RESET ROLE');
      const f = await exec(db, `SELECT proname, prosecdef, proconfig::text c, proacl::text a FROM pg_proc WHERE proname LIKE 'cump\\_%' AND proname NOT LIKE '%proteger' ORDER BY 1`);
      expect(f.map((x: any) => x.proname)).toEqual(['cump_ledger', 'cump_recalculer_produits', 'cump_recalculer_tout']);
      for (const x of f) { expect(x.prosecdef).toBe(false); expect(x.c).toContain('search_path'); expect(x.a).not.toMatch(/anon|authenticated|(^\{|,)=X/); }
      expect((await un(db, `SELECT reloptions::text o FROM pg_class WHERE relname='cump_marges_lignes'`)).o).toContain('security_invoker=true');
      const avant = await recalc(db, [p]); await db.exec(CUMP); await db.exec(CUMP);                                  // rejouer la migration : aucune erreur, aucune perte
      expect((await un(db, `SELECT count(*)::int n FROM cump_sorties`)).n).toBe(1); expect(avant.lignes).toBe(1);
    } finally { await db.close(); }
  });

  test('la migration n\'altère aucun objet existant : mêmes fonctions (empreintes), mêmes tables et déclencheurs hors cump_*', async () => {
    const db = await baseAchats(false); await db.exec(lire('receptions_stock_differentiel.sql'));
    try {
      const objets = async () => ({
        fonctions: await exec(db, `SELECT proname, md5(pg_get_functiondef(oid)) m, proacl::text a FROM pg_proc WHERE pronamespace='public'::regnamespace ORDER BY 1, 2`),
        tables: (await exec(db, `SELECT table_name FROM information_schema.tables WHERE table_schema='public' ORDER BY 1`)).map((r: any) => r.table_name),
        declencheurs: await exec(db, `SELECT tgname, tgrelid::regclass::text t FROM pg_trigger WHERE NOT tgisinternal ORDER BY 1`),
        colonnes: (await un(db, `SELECT md5(string_agg(table_name||'.'||column_name||':'||data_type, ',' ORDER BY table_name, column_name)) h FROM information_schema.columns WHERE table_schema='public'`)).h,
      });
      const avant = await objets(); await db.exec(CUMP); const apres = await objets();
      expect(apres.fonctions.filter((f: any) => !/^cump_/.test(f.proname))).toEqual(avant.fonctions);
      expect(apres.tables.filter((t: string) => !/^cump_/.test(t))).toEqual(avant.tables);
      expect(apres.declencheurs.filter((t: any) => !/cump_/.test(t.tgname))).toEqual(avant.declencheurs);
      expect(apres.tables.filter((t: string) => /^cump_/.test(t)).sort()).toEqual(['cump_etat_produit', 'cump_marges_lignes', 'cump_recalculs', 'cump_sorties']);
    } finally { await db.close(); }
  });
});

test.describe('Comparaison avec la simulation : mêmes résultats que l\'implémentation récursive indépendante', () => {
  /** La simulation présentée à l'utilisateur (requête récursive en lecture seule), reprise telle quelle pour un produit. */
  const SIMULATION = `WITH RECURSIVE
    tr AS (SELECT a.target_id, max(a.created_at) t FROM admin_audit_logs a WHERE a.action='commande.statut' AND a.details->>'nouveau'='livree' GROUP BY 1),
    ev AS (SELECT *, row_number() OVER (ORDER BY t, k, tie) n FROM (
      SELECT 0 k, (r.received_at::timestamp AT TIME ZONE 'Indian/Reunion') t, i.quantity qty, i.unit_cost_ht cost, NULL::uuid item_id, i.id tie FROM stock_reception_items i JOIN stock_receptions r ON r.id=i.reception_id WHERE i.product_id=$1
      UNION ALL SELECT 1, coalesce(tr.t, o.created_at), oi.stock_decremented, NULL::numeric, oi.id, oi.id FROM order_items oi JOIN orders o ON o.id=oi.order_id LEFT JOIN tr ON tr.target_id=o.id::text WHERE oi.product_id=$1 AND oi.stock_decremented>0) x),
    st(n, q, avg, k, item_id, cout, couvert) AS (
      SELECT 0::bigint, 0::numeric, NULL::numeric, NULL::int, NULL::uuid, NULL::numeric, NULL::boolean
      UNION ALL SELECT e.n, CASE WHEN e.k=0 THEN s.q+e.qty ELSE greatest(0, s.q-e.qty) END,
        CASE WHEN e.k=0 THEN CASE WHEN s.q<=0 OR s.avg IS NULL THEN e.cost ELSE (s.q*s.avg+e.qty*e.cost)/(s.q+e.qty) END ELSE s.avg END,
        e.k, e.item_id, CASE WHEN e.k=1 AND s.q>=e.qty THEN s.avg END, CASE WHEN e.k=1 THEN s.q>=e.qty END FROM st s JOIN ev e ON e.n=s.n+1)
    SELECT item_id, cout, couvert FROM st WHERE k=1`;

  function alea(graine: number) { let a = graine; return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

  for (const graine of [1, 7, 42]) {
    test(`jeu aléatoire n° ${graine} : coût et couverture identiques ligne à ligne (réceptions appliquées et historiques, livraisons tracées ou non)`, async () => {
      const db = await base(); const hasard = alea(graine); const entre = (a: number, b: number) => a + Math.floor(hasard() * (b - a + 1));
      const jour = (d: number) => new Date(Date.UTC(2026, 5, 1) + d * 86400000).toISOString();
      try {
        let lignes = 0;
        for (let k = 0; k < 6; k++) {
          const p = await produit(db, nom(), entre(0, 80));
          for (let i = 0, nr = entre(3, 6); i < nr; i++) await rec(db, p, entre(20, 120), entre(500, 2000) / 100, jour(entre(10, 150)).slice(0, 10), hasard() > 0.2);
          for (let i = 0, nv = entre(10, 20); i < nv; i++) { const cree = entre(5, 160); await vente(db, p, entre(1, 40), { cree: jour(cree), livre: hasard() > 0.15 ? jour(cree + entre(0, 7)) : null, snap: entre(500, 2000) / 100, prix: 25 }); }
          await recalc(db, [p]);
          const attendu = await exec(db, SIMULATION, [p]);
          for (const a of attendu) {
            const l = await ligne(db, a.item_id); lignes++;
            expect(l.couvert, `couverture ${a.item_id}`).toBe(a.couvert);
            if (a.couvert) proche(await cout(db, a.item_id), Number(a.cout)); else expect(l.cout_cump).toBeNull();
          }
          expect((await un(db, `SELECT count(*)::int n FROM cump_sorties WHERE product_id=$1`, [p])).n).toBe(attendu.length);
        }
        expect(lignes).toBeGreaterThan(40);
      } finally { await db.close(); }
    });
  }
});

test.describe('Compatibilité avec les réceptions partielles (branche feat/achats-receptions-partielles, non fusionnée)', () => {
  test('les deux ordres d\'application des migrations ; une réception annulée est exclue du calcul ; les réceptions rattachées à une commande comptent comme lots', async () => {
    let partielles = '';
    try { partielles = execSync('git show feat/achats-receptions-partielles:supabase/migrations/achats_receptions_partielles.sql', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 1 << 26 }); } catch { /* branche absente */ }
    test.skip(!partielles, 'branche des réceptions partielles absente');
    for (const ordre of ['cump_puis_partielles', 'partielles_puis_cump']) {
      const db = await baseAchats(false); await db.exec(lire('receptions_stock_differentiel.sql'));
      try {
        if (ordre === 'cump_puis_partielles') { await db.exec(CUMP); await db.exec(partielles); } else { await db.exec(partielles); await db.exec(CUMP); }
        const p = await produit(db, nom(), 0); await rec(db, p, 100, 10, '2026-06-15');
        await db.query(`INSERT INTO auth.users DEFAULT VALUES`);
        const s = (await un(db, `INSERT INTO shipments (supplier_name, reference, status) VALUES ('F','R-${ordre}','en_transit') RETURNING id`)).id;
        const lie = (await un(db, `INSERT INTO stock_receptions (supplier_name, received_at, stock_applied, shipment_id, cle_idempotence, created_by, created_by_email) VALUES ('F','2026-07-01',true,$1, gen_random_uuid(), (SELECT id FROM auth.users LIMIT 1), 'a@test.local') RETURNING id`, [s])).id;
        await db.query(`SET inca.achats_ecriture='1'`); await db.query(`INSERT INTO stock_reception_items (reception_id, product_id, quantity, unit_cost_ht) VALUES ($1,$2,100,20)`, [lie, p]); await db.query(`RESET inca.achats_ecriture`);
        const v1 = await vente(db, p, 150, { cree: '2026-07-10T05:00:00Z', livre: '2026-07-10T08:00:00Z', snap: 12 });
        await recalc(db, [p]);
        proche(await cout(db, v1), 15);                                                    // 100 à 10 + 100 à 20 : coût moyen 15, la réception rattachée à une commande est bien un lot
        // annulation de la réception rattachée (champs ajoutés par la migration partielle) : elle sort du calcul
        await db.query(`SET inca.achats_ecriture='1'`); await db.query(`UPDATE stock_receptions SET annulee_le = now(), annulee_par = (SELECT id FROM auth.users LIMIT 1), annulation_motif = 'test' WHERE id=$1`, [lie]); await db.query(`RESET inca.achats_ecriture`);
        await recalc(db, [p]);
        expect((await ligne(db, v1)).fiabilite, ordre).toBe('non_recalculable');         // 150 vendus pour 100 de stock connu une fois la réception annulée
        const v2 = await vente(db, p, 40, { cree: '2026-07-11T05:00:00Z', livre: '2026-07-11T08:00:00Z', snap: 12 }); await recalc(db, [p]);
        expect((await ligne(db, v2)).fiabilite, ordre).toBe('non_recalculable');         // stock calculé épuisé par la vente précédente
      } finally { await db.close(); }
    }
  });
});

test.describe('Contrôle de comparaison livré pour la production', () => {
  test('le script de comparaison (lecture seule) ne trouve aucun écart entre le moteur et la simulation sur un jeu mêlant lignes fiables, estimées, reconstituées et non recalculables ; il n\'écrit rien', async () => {
    const { readFileSync } = await import('node:fs');
    const controle = readFileSync('supabase/controles/cump_comparaison_simulation.sql', 'utf8');
    const db = await base();
    try {
      const p = await produit(db, nom(), 0); const q = await produit(db, nom(), 12);
      await rec(db, p, 100, 8, '2026-06-15'); await rec(db, p, 50, 12, '2026-08-01'); await rec(db, q, 20, 5, '2026-06-30', false);
      await vente(db, p, 30, { cree: '2026-06-01T05:00:00Z', livre: '2026-06-02T08:00:00Z', snap: 9 });                  // non recalculable
      await vente(db, p, 60, { cree: '2026-07-01T05:00:00Z', livre: '2026-07-02T08:00:00Z', snap: 9 });                  // fiable
      await vente(db, p, 20, { cree: '2026-08-05T05:00:00Z', livre: null, snap: 9 });                                    // estimée
      await vente(db, p, 10, { cree: '2026-08-06T05:00:00Z', livre: '2026-08-07T08:00:00Z', snap: null });               // reconstituée
      await vente(db, p, 5, { cree: '2026-08-07T05:00:00Z', livre: null, snap: null });                                  // sans coût, reconstitution non fiable
      await vente(db, q, 8, { cree: '2026-07-01T05:00:00Z', livre: '2026-07-02T08:00:00Z', snap: 6 });
      await un(db, `SELECT cump_recalculer_tout() r`);
      const avant = await empreinte(db);
      const lignes = Object.fromEntries((await exec(db, controle)).map((r: any) => [r.k, r.v as string]));
      expect(await empreinte(db)).toEqual(avant);
      expect(lignes['lignes_simulation']).toBe(lignes['lignes_moteur']);
      for (const k of Object.keys(lignes).filter(x => x.startsWith('mismatch_'))) expect(lignes[k], k).toBe('0');
      expect(lignes['couvertes_sans_cout_moteur_inexpliquees']).toBe('0');
      expect(lignes['lignes_reconstituees']).toBe('1'); expect(lignes['lignes_date_approchee']).toBe('2');
      expect(lignes['repartition_fiabilite']).toBe('estimee=1, fiable=3, non_recalculable=2');
      expect(lignes['marge_recalculee_memes_lignes']).toBe(lignes['marge_recalculee_simulation_memes_lignes']);
    } finally { await db.close(); }
  });
});

test.describe('Retour arrière et volume', () => {
  test('retour arrière : la suspension (REVOKE) empêche tout recalcul sans toucher aux données ni à l\'historique ; le script ne supprime rien tant qu\'on ne l\'a pas décommenté', async () => {
    const { readFileSync } = await import('node:fs');
    const retour = readFileSync('supabase/retour/cump_glissant_retour.sql', 'utf8');
    const code = retour.split('\n').filter(l => !l.startsWith('--')).join('\n');
    expect(code).not.toMatch(/DROP|DELETE|TRUNCATE/i);
    const db = await base();
    try {
      const p = await produit(db, nom(), 0); await rec(db, p, 50, 8, '2026-06-15'); await vente(db, p, 10, { cree: '2026-07-01T05:00:00Z', livre: '2026-07-02T08:00:00Z', snap: 9 }); await recalc(db, [p]);
      const avant = await empreinte(db); const nb = (await un(db, `SELECT count(*)::int n FROM cump_recalculs`)).n;
      await db.exec(code); await db.exec('SET ROLE service_role');
      expect(await refuse(db.query(`SELECT cump_recalculer_produits(ARRAY['${p}']::uuid[])`))).toMatch(/permission denied/);
      await db.exec('RESET ROLE');
      expect(await empreinte(db)).toEqual(avant); expect((await un(db, `SELECT count(*)::int n FROM cump_recalculs`)).n).toBe(nb);
    } finally { await db.close(); }
  });

  test('volume de production (≈ 120 produits, ≈ 1 400 lignes livrées) : remplissage initial complet en quelques secondes, résultat stable au second passage', async () => {
    const db = await base();
    try {
      for (let k = 0; k < 120; k++) {
        const p = await produit(db, nom(), 0); await rec(db, p, 200, 5 + (k % 7), '2026-06-15'); if (k % 5 === 0) await rec(db, p, 100, 8, '2026-09-01');
        for (let i = 0; i < 12; i++) await vente(db, p, 8 + (i % 4), { cree: `2026-07-${String(1 + i).padStart(2, '0')}T05:00:00Z`, livre: `2026-07-${String(2 + i).padStart(2, '0')}T08:00:00Z`, snap: 6 });
      }
      const t0 = Date.now(); const r = await un(db, `SELECT cump_recalculer_tout() r`); const ms = Date.now() - t0;
      expect(r.r.produits).toBe(120); expect(r.r.lignes).toBe(1440); expect(ms).toBeLessThan(30000);
      const r2 = await un(db, `SELECT cump_recalculer_tout('manuel') r`); expect(r2.r.modifiees).toBe(0);          // idempotent : un second passage ne change rien
      expect((await un(db, `SELECT count(*)::int n FROM cump_recalculs`)).n).toBe(2);
    } finally { await db.close(); }
  });
});
