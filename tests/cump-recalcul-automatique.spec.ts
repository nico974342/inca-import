/**
 * CUMP glissant — recalcul AUTOMATIQUE (supabase/migrations/cump_recalcul_automatique.sql) : boîte d'envoi transactionnelle, déclencheurs, traitement, reprise, filet de sécurité.
 * Base locale PGlite (vrai PostgreSQL), vraies migrations du dépôt dont le correctif des réceptions déjà en production. Aucune connexion distante.
 * Les accès réellement simultanés (plusieurs connexions) sont testés par supabase/controles/concurrence_cump.mjs sur un PostgreSQL local jetable.
 */
import { test, expect } from '@playwright/test';
import { execSync } from 'node:child_process';
import type { PGlite } from '@electric-sql/pglite';
import { baseAchats, lire, un, exec, produit } from './helpers/receptionsBase';

const M1 = lire('cump_glissant.sql'); const M2 = lire('cump_recalcul_automatique.sql');
let n = 0; const nom = () => `Produit ${++n}`;

async function base(actif = true): Promise<PGlite> {
  const db = await baseAchats(false); await db.exec(lire('receptions_stock_differentiel.sql')); await db.exec(M1); await db.exec(M2);
  if (actif) await db.query(`SELECT cump_activer_recalcul_automatique(true)`);
  return db;
}
const rec = async (db: PGlite, p: string, q: number, c: number, date: string, appliquee = true) =>
  (await un(db, `SELECT reception_create('F', $1::date, NULL, $2, $3::jsonb) id`, [date, appliquee, JSON.stringify([{ product_id: p, quantity: q, unit_cost_ht: c }])])).id as string;
const majCout = (db: PGlite, r: string, p: string, q: number, c: number, date = '2026-10-28') =>
  db.query(`SELECT reception_update($1,'F',$3::date,NULL,true,$2::jsonb)`, [r, JSON.stringify([{ product_id: p, quantity: q, unit_cost_ht: c }]), date]);
/** Livraison réelle : commande créée à `cree`, déduction du stock par order_mark_livree (fonction réelle), trace au journal d'audit à `livre` comme le fait la page des commandes. */
async function livrer(db: PGlite, p: string, qty: number, o: { cree: string; livre: string | null; prix?: number; tracer?: boolean }) {
  const snap = (await un(db, `SELECT prix_achat_moyen_ht s FROM products WHERE id=$1`, [p])).s;
  const cmd = (await un(db, `INSERT INTO orders (status, created_at) VALUES ('en_attente', $1::timestamptz) RETURNING id`, [o.cree])).id as string;
  const it = (await un(db, `INSERT INTO order_items (order_id, product_id, product_name, quantity, price_ht_snapshot, pump_snapshot) VALUES ($1,$2,'x',$3,$4,$5) RETURNING id`, [cmd, p, qty, o.prix ?? 20, snap])).id as string;
  await db.query(`UPDATE orders SET status='livree' WHERE id=$1`, [cmd]); await db.query(`SELECT * FROM order_mark_livree($1)`, [cmd]);
  if (o.livre && o.tracer !== false) await trace(db, cmd, o.livre);
  return { cmd, it };
}
const trace = (db: PGlite, cmd: string, quand: string, ancien = 'en_attente', nouveau = 'livree') =>
  db.query(`INSERT INTO admin_audit_logs (admin_email, action, target_type, target_id, details, created_at) VALUES ('a@x.local','commande.statut','order',$1,$2::jsonb,$3::timestamptz)`, [cmd, JSON.stringify({ ancien, nouveau }), quand]);
const file = async (db: PGlite, where = '') => exec(db, `SELECT * FROM cump_file ${where} ORDER BY cree_le, id`);
const nbFile = async (db: PGlite, statut: string) => (await un(db, `SELECT count(*)::int n FROM cump_file WHERE statut=$1`, [statut])).n as number;
const traiter = async (db: PGlite) => (await un(db, `SELECT cump_traiter_file() r`)).r;
const ligne = async (db: PGlite, it: string) => un(db, `SELECT * FROM cump_sorties WHERE order_item_id=$1`, [it]);
const cout = async (db: PGlite, it: string) => { const l = await ligne(db, it); return l?.cout_cump == null ? null : Number(l.cout_cump); };
const proche = (a: number | null, b: number) => { expect(a).not.toBeNull(); expect(Math.abs((a as number) - b)).toBeLessThan(1e-9); };
const refuse = async (f: Promise<unknown>) => { try { await f; return ''; } catch (e: any) { return String(e.message); } };
async function empreinte(db: PGlite) {
  const tables = (await exec(db, `SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE' AND table_name NOT LIKE 'cump\\_%' ORDER BY 1`)).map((r: any) => r.table_name as string);
  const out: Record<string, string> = {};
  for (const t of tables) out[t] = (await un(db, `SELECT md5(coalesce(string_agg(to_jsonb(x)::text, ',' ORDER BY to_jsonb(x)::text), '')) h FROM "${t}" x`)).h;
  return out;
}

test.describe('Parcours complet : réception → commande → livraison → marge → correction d\'une ancienne réception → recalcul', () => {
  test('chaque événement dépose une demande, le traitement calcule les marges, la correction d\'un ancien coût ne recalcule que les ventes concernées, tout est tracé', async () => {
    const db = await base();
    try {
      const p = await produit(db, nom(), 0);
      const r1 = await rec(db, p, 120, 13.32, '2026-08-11'); await rec(db, p, 120, 13.2, '2026-08-25'); const r3 = await rec(db, p, 120, 7.92, '2026-10-28');
      expect(await file(db)).toHaveLength(1);                                                   // 3 réceptions = une seule demande fusionnée
      expect((await file(db))[0]).toMatchObject({ statut: 'en_attente', origine: 'reception', product_id: p }); expect((await file(db))[0].evenements).toBeGreaterThanOrEqual(3);

      const v1 = await livrer(db, p, 100, { cree: '2026-08-12T05:00:00Z', livre: '2026-08-12T08:00:00Z' });
      const v2 = await livrer(db, p, 50, { cree: '2026-10-26T05:00:00Z', livre: '2026-10-29T08:00:00Z' });          // créée avant la réception du 28/10, livrée après
      const v3 = await livrer(db, p, 30, { cree: '2026-11-05T05:00:00Z', livre: '2026-11-05T08:00:00Z' });
      expect(await file(db)).toHaveLength(1);                                                   // les livraisons rejoignent la même demande en attente

      // marge « non actualisée » tant que le calcul n'est pas fait
      let vue = await exec(db, `SELECT DISTINCT etat_recalcul, marge_actualisee FROM cump_marges_lignes_suivi WHERE product_id=$1`, [p]);
      expect(vue).toEqual([{ etat_recalcul: 'en_attente', marge_actualisee: false }]);

      expect(await traiter(db)).toMatchObject({ traitees: 1, reussies: 1, en_erreur: 0 });
      expect(await nbFile(db, 'reussi')).toBe(1); expect(await nbFile(db, 'en_attente')).toBe(0);
      vue = await exec(db, `SELECT DISTINCT etat_recalcul, marge_actualisee FROM cump_marges_lignes_suivi WHERE product_id=$1`, [p]);
      expect(vue).toEqual([{ etat_recalcul: 'a_jour', marge_actualisee: true }]);

      const avg2 = (20 * 13.32 + 120 * 13.2) / 140; const avg3 = (140 * avg2 + 120 * 7.92) / 260;
      proche(await cout(db, v1.it), 13.32); proche(await cout(db, v2.it), avg3); proche(await cout(db, v3.it), avg3);
      expect((await ligne(db, v2.it)).fiabilite).toBe('fiable');
      // coût prévisionnel (à la commande) et réalisé (à la livraison), côte à côte
      const m = await un(db, `SELECT marge_previsionnelle, marge_realisee, cout_previsionnel, cout_realise FROM cump_marges_lignes WHERE order_item_id=$1`, [v2.it]);
      expect(Number(m.marge_realisee)).toBeCloseTo(50 * (20 - avg3), 6); expect(Number(m.cout_previsionnel)).not.toBeNull();

      // correction d'un ancien coût : seules les ventes livrées après cette réception sont recalculées
      const stockAvant = (await un(db, `SELECT stock_quantity s FROM products WHERE id=$1`, [p])).s; const sansCump = await empreinte(db);
      await majCout(db, r3, p, 120, 9);
      expect(await empreinte(db)).not.toEqual(sansCump);                                        // (la réception a bien changé, c'est l'événement lui-même)
      expect((await un(db, `SELECT stock_quantity s FROM products WHERE id=$1`, [p])).s).toBe(stockAvant);   // prix seul : aucune variation de stock
      vue = await exec(db, `SELECT DISTINCT etat_recalcul FROM cump_marges_lignes_suivi WHERE product_id=$1`, [p]); expect(vue).toEqual([{ etat_recalcul: 'en_attente' }]);
      const apresEvenement = await empreinte(db);
      await traiter(db);
      expect(await empreinte(db)).toEqual(apresEvenement);                                      // le traitement n'écrit RIEN hors cump_* : stocks, réservations, commandes, prix, réceptions, journal d'audit
      const avg3b = (140 * avg2 + 120 * 9) / 260;
      proche(await cout(db, v1.it), 13.32); proche(await cout(db, v2.it), avg3b); proche(await cout(db, v3.it), avg3b);
      expect(Number((await ligne(db, v2.it)).cout_initial)).toBe(Number((await un(db, `SELECT pump_snapshot s FROM order_items WHERE id=$1`, [v2.it])).s));   // coût d'origine conservé
      const j = await un(db, `SELECT * FROM cump_recalculs WHERE declencheur='auto_reception' AND lignes_modifiees > 0 ORDER BY cree_le DESC LIMIT 1`);
      expect(j.reception_id).toBe(r3); expect(j.lignes_modifiees).toBe(2); expect(Number(j.marge_apres)).toBeLessThan(Number(j.marge_avant));
      expect((await un(db, `SELECT count(*)::int n FROM cump_recalculs WHERE declencheur LIKE 'auto\\_%'`)).n).toBe(2);   // 1er calcul (lignes nouvelles) + correction ; les passages sans changement n'encombrent pas le journal
      void r1;
    } finally { await db.close(); }
  });

  test('livraison annulée puis refaite : la demande est déposée à chaque étape, le calcul dérivé suit, les quantités physiques ne sont jamais touchées par le calcul', async () => {
    const db = await base();
    try {
      const p = await produit(db, nom(), 0); await rec(db, p, 100, 8, '2026-06-15'); await traiter(db);
      const v = await livrer(db, p, 10, { cree: '2026-07-01T05:00:00Z', livre: '2026-07-02T08:00:00Z' }); await traiter(db);
      expect(await ligne(db, v.it)).toBeDefined();
      await db.query(`SELECT * FROM order_cancel_livree($1)`, [v.cmd]); await trace(db, v.cmd, '2026-07-03T08:00:00Z', 'livree', 'en_attente');       // retour arrière de livraison
      expect(await nbFile(db, 'en_attente')).toBe(1);
      const stock = (await un(db, `SELECT stock_quantity s FROM products WHERE id=$1`, [p])).s; await traiter(db);
      expect(await ligne(db, v.it)).toBeUndefined(); expect((await un(db, `SELECT stock_quantity s FROM products WHERE id=$1`, [p])).s).toBe(stock);
      await db.query(`UPDATE order_items SET stock_decremented = NULL WHERE id = $1`, [v.it]);                                    // (déjà NULL après le retour arrière : aucun nouvel événement)
      await db.query(`SELECT * FROM order_mark_livree($1)`, [v.cmd]); await trace(db, v.cmd, '2026-07-04T08:00:00Z');             // nouvelle livraison
      await traiter(db); expect(await ligne(db, v.it)).toBeDefined(); expect((await ligne(db, v.it)).source_date).toBe('journal_livraison');
    } finally { await db.close(); }
  });

  test('la date de livraison vient du journal, écrit APRÈS la déduction du stock : un calcul intercalé est corrigé automatiquement par la demande que dépose la trace', async () => {
    const db = await base();
    try {
      const p = await produit(db, nom(), 0); await rec(db, p, 100, 8, '2026-06-15'); await rec(db, p, 100, 20, '2026-07-10'); await traiter(db);
      const v = await livrer(db, p, 150, { cree: '2026-07-11T05:00:00Z', livre: '2026-07-12T08:00:00Z', tracer: false });                // stock déduit, trace pas encore écrite
      await traiter(db);                                                                                                           // un traitement passe exactement entre les deux
      expect((await ligne(db, v.it)).fiabilite).toBe('estimee'); expect((await ligne(db, v.it)).source_date).toBe('creation_commande_approchee');
      await trace(db, v.cmd, '2026-07-12T08:00:00Z');                                                                              // la trace arrive : nouvelle demande
      expect(await nbFile(db, 'en_attente')).toBe(1); await traiter(db);
      expect((await ligne(db, v.it)).fiabilite).toBe('fiable'); expect((await ligne(db, v.it)).source_date).toBe('journal_livraison');
      proche(await cout(db, v.it), (100 * 8 + 100 * 20) / 200);                                                                   // 150 cartons livrés le 12/07 : lots du 15/06 et du 10/07
    } finally { await db.close(); }
  });
});

test.describe('Fiabilité : un problème de calcul ne bloque jamais une réception ni une livraison, rien n\'est perdu', () => {
  test('interrupteur « off » : aucune demande, comportement inchangé ; opération refusée : aucune demande (même transaction)', async () => {
    const db = await base(false);
    try {
      const p = await produit(db, nom(), 0); const r = await rec(db, p, 100, 8, '2026-06-15'); await livrer(db, p, 90, { cree: '2026-07-01T05:00:00Z', livre: '2026-07-02T08:00:00Z' });
      expect(await file(db)).toHaveLength(0); expect((await un(db, `SELECT cump_auto_actif() a`)).a).toBe(false);
      await db.query(`SELECT cump_activer_recalcul_automatique(true)`);
      expect(await refuse(majCout(db, r, p, 5, 8))).toContain('STOCK_INSUFFISANT_RECEPTION');                                     // retirerait 95 cartons alors qu'il en reste 10
      expect(await file(db)).toHaveLength(0);                                                                                      // refus = annulation complète, aucune demande orpheline
      await majCout(db, r, p, 100, 9); expect(await file(db)).toHaveLength(1);
    } finally { await db.close(); }
  });

  test('déclencheur en panne : la réception réussit quand même (stock à jour), un avertissement est émis, et le balayage redépose la demande manquante', async () => {
    const db = await base();
    try {
      const p = await produit(db, nom(), 0);
      await db.exec(`ALTER TABLE cump_file RENAME TO cump_file_en_panne`);                                                       // la boîte d'envoi devient inaccessible
      const r = await rec(db, p, 40, 8, '2026-06-15');                                                                            // la réception NE DOIT PAS échouer
      expect((await un(db, `SELECT stock_quantity s FROM products WHERE id=$1`, [p])).s).toBe(40); expect(r).toBeTruthy();
      await db.exec(`ALTER TABLE cump_file_en_panne RENAME TO cump_file`);
      expect(await file(db)).toHaveLength(0);                                                                                      // demande perdue par le déclencheur…
      expect((await un(db, `SELECT cump_detecter_obsoletes() n`)).n).toBe(1);                                                    // …retrouvée par le filet de sécurité
      expect((await file(db))[0]).toMatchObject({ origine: 'balayage', product_id: p }); await traiter(db);
      expect((await un(db, `SELECT quantite_calculee q FROM cump_etat_produit WHERE product_id=$1`, [p])).q).toBe('40');
      expect((await un(db, `SELECT cump_detecter_obsoletes() n`)).n).toBe(0);                                                    // état stable : plus rien à signaler
    } finally { await db.close(); }
  });

  test('erreur de calcul : demande reprogrammée à délai croissant puis « échoue » (visible, erreur conservée) ; reprise sans doublon ; résultat identique à un calcul sans panne', async () => {
    const db = await base();
    try {
      const p = await produit(db, nom(), 0); await rec(db, p, 100, 8, '2026-06-15'); await rec(db, p, 100, 12, '2026-07-10'); await traiter(db);
      const v = await livrer(db, p, 150, { cree: '2026-07-11T05:00:00Z', livre: '2026-07-12T08:00:00Z' });
      await db.exec(`CREATE FUNCTION panne_cump() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF coalesce(current_setting('inca.panne_cump', true), '') = '1' THEN RAISE EXCEPTION 'panne simulée du calcul'; END IF; RETURN NEW; END $$;
        CREATE TRIGGER trg_panne_cump BEFORE INSERT OR UPDATE ON cump_sorties FOR EACH ROW EXECUTE FUNCTION panne_cump();
        CREATE TRIGGER trg_panne_cump_etat BEFORE INSERT OR UPDATE ON cump_etat_produit FOR EACH ROW EXECUTE FUNCTION panne_cump();`);
      await db.exec(`SET inca.panne_cump = '1'`);

      expect(await traiter(db)).toMatchObject({ traitees: 1, reussies: 0, en_erreur: 1 });
      let f = (await file(db, `WHERE statut <> 'reussi'`))[0]; expect(f).toMatchObject({ statut: 'en_attente', tentatives: 1 }); expect(f.derniere_erreur).toContain('panne simulée'); expect(new Date(f.disponible_apres).getTime()).toBeGreaterThan(Date.now());
      expect(await ligne(db, v.it)).toBeUndefined();                                                                                // aucun résultat partiel
      expect(await traiter(db)).toMatchObject({ traitees: 0 });                                                                     // pas avant le délai
      expect((await exec(db, `SELECT DISTINCT etat_recalcul FROM cump_marges_lignes_suivi WHERE product_id=$1`, [p]))).toEqual([{ etat_recalcul: 'en_attente' }]);
      for (let i = 0; i < 4; i++) { await db.query(`UPDATE cump_file SET disponible_apres = now() WHERE statut='en_attente'`); await traiter(db); }
      f = (await file(db, `WHERE product_id='${p}' AND statut <> 'reussi'`))[0]; expect(f).toMatchObject({ statut: 'echoue', tentatives: 5 }); expect(f.derniere_erreur).toContain('panne simulée');
      expect((await exec(db, `SELECT DISTINCT etat_recalcul, marge_actualisee FROM cump_marges_lignes_suivi WHERE product_id=$1`, [p]))).toEqual([{ etat_recalcul: 'echec', marge_actualisee: false }]);
      expect((await un(db, `SELECT cump_etat_file() e`)).e).toMatchObject({ echoue: 1, en_attente: 0, automatique: true });

      await db.exec(`SET inca.panne_cump = '0'`);
      expect((await un(db, `SELECT cump_reprendre_echecs() r`)).r).toEqual({ reprises: 1, fusionnees: 0 });
      expect((await un(db, `SELECT cump_reprendre_echecs() r`)).r).toEqual({ reprises: 0, fusionnees: 0 });                         // rejouer la reprise ne duplique rien
      await traiter(db); expect(await nbFile(db, 'en_attente')).toBe(0);
      proche(await cout(db, v.it), (100 * 8 + 100 * 12) / 200);
      expect((await un(db, `SELECT count(*)::int n FROM cump_sorties WHERE product_id=$1`, [p])).n).toBe(1);

      // un échec repris alors qu'une demande est déjà en attente pour le produit est fusionné, pas dupliqué
      await db.exec(`SET inca.panne_cump = '1'`); await db.query(`SELECT * FROM order_cancel_livree($1)`, [v.cmd]); await traiter(db);
      await db.query(`UPDATE cump_file SET tentatives = 4, disponible_apres = now() WHERE statut='en_attente'`); await traiter(db); expect(await nbFile(db, 'echoue')).toBe(1);
      await db.exec(`SET inca.panne_cump = '0'`); await rec(db, p, 10, 9, '2026-07-20');                                              // nouvel événement : nouvelle demande en attente
      expect((await un(db, `SELECT cump_reprendre_echecs() r`)).r).toEqual({ reprises: 0, fusionnees: 1 });
      expect(await nbFile(db, 'en_attente')).toBe(1); await traiter(db); expect((await un(db, `SELECT count(*)::int n FROM cump_file WHERE product_id=$1 AND statut='en_attente'`, [p])).n).toBe(0);
    } finally { await db.close(); }
  });

  test('coupure pendant le traitement : tout est annulé, la demande reste en attente sans résultat partiel, et le traitement suivant aboutit', async () => {
    const db = await base();
    try {
      const p = await produit(db, nom(), 0); await rec(db, p, 100, 8, '2026-06-15'); const v = await livrer(db, p, 10, { cree: '2026-07-01T05:00:00Z', livre: '2026-07-02T08:00:00Z' });
      await db.exec('BEGIN'); await traiter(db); await db.exec('ROLLBACK');                                                       // connexion coupée avant la validation
      expect(await nbFile(db, 'en_attente')).toBe(1); expect((await file(db))[0].tentatives).toBe(0); expect(await ligne(db, v.it)).toBeUndefined();
      await traiter(db); expect(await ligne(db, v.it)).toBeDefined(); expect(await nbFile(db, 'reussi')).toBe(1);
    } finally { await db.close(); }
  });

  test('traitements successifs et événements rapprochés : une seule demande en attente par produit, jamais de doublon ; rejouer le calcul est sans effet', async () => {
    const db = await base();
    try {
      const p = await produit(db, nom(), 0); for (let i = 0; i < 6; i++) await rec(db, p, 10, 5 + i, `2026-06-${10 + i}`);
      expect(await file(db)).toHaveLength(1); expect((await file(db))[0].evenements).toBe(6);
      await traiter(db); await livrer(db, p, 5, { cree: '2026-07-01T05:00:00Z', livre: '2026-07-02T08:00:00Z' }); await livrer(db, p, 5, { cree: '2026-07-03T05:00:00Z', livre: '2026-07-04T08:00:00Z' });
      expect(await nbFile(db, 'en_attente')).toBe(1); await traiter(db);
      const avant = await exec(db, `SELECT order_item_id, cout_cump, fiabilite FROM cump_sorties ORDER BY order_item_id`);
      await db.query(`SELECT cump_recalculer_produits(ARRAY['${p}']::uuid[], 'auto_balayage')`); await db.query(`SELECT cump_recalculer_produits(ARRAY['${p}']::uuid[], 'auto_balayage')`);
      expect(await exec(db, `SELECT order_item_id, cout_cump, fiabilite FROM cump_sorties ORDER BY order_item_id`)).toEqual(avant);
      expect((await un(db, `SELECT count(*)::int n FROM cump_recalculs WHERE declencheur='auto_balayage'`)).n).toBe(0);
    } finally { await db.close(); }
  });

  test('filet de sécurité : une modification faite hors application (déclencheurs absents, stock corrigé à la main) est détectée par l\'empreinte et recalculée', async () => {
    const db = await base();
    try {
      const p = await produit(db, nom(), 0); await rec(db, p, 100, 8, '2026-06-15'); const v = await livrer(db, p, 10, { cree: '2026-07-01T05:00:00Z', livre: '2026-07-02T08:00:00Z' }); await traiter(db);
      expect((await un(db, `SELECT cump_detecter_obsoletes() n`)).n).toBe(0);
      await db.exec(`ALTER TABLE stock_reception_items DISABLE TRIGGER trg_cump_lignes_reception`);
      await db.query(`UPDATE stock_reception_items SET unit_cost_ht = 6 WHERE product_id=$1`, [p]);                                 // coût modifié sans déclencheur
      expect(await file(db, `WHERE statut='en_attente'`)).toHaveLength(0);
      expect((await un(db, `SELECT cump_detecter_obsoletes() n`)).n).toBe(1); await traiter(db); proche(await cout(db, v.it), 6);
      await db.exec(`ALTER TABLE stock_reception_items ENABLE TRIGGER trg_cump_lignes_reception`);
      await db.query(`UPDATE products SET stock_quantity = 77 WHERE id=$1`, [p]);                                                  // stock corrigé à la main
      expect((await un(db, `SELECT cump_detecter_obsoletes() n`)).n).toBe(1); await traiter(db);
      expect((await un(db, `SELECT coherent FROM cump_etat_produit WHERE product_id=$1`, [p])).coherent).toBe(false);
    } finally { await db.close(); }
  });
});

test.describe('Droits, étanchéité et compatibilité', () => {
  test('droits : serveur seulement ; déclencheurs en SECURITY DEFINER à search_path figé qui fonctionnent pour le rôle serveur ; anon et authenticated refusés partout', async () => {
    const db = await base();
    try {
      const p = await produit(db, nom(), 0);
      for (const role of ['anon', 'authenticated']) {
        await db.exec(`SET ROLE ${role}`);
        for (const q of [`SELECT * FROM cump_file`, `SELECT * FROM cump_config`, `UPDATE cump_config SET valeur='on'`, `SELECT * FROM cump_marges_lignes_suivi`, `SELECT cump_traiter_file()`, `SELECT cump_etat_file()`,
          `SELECT cump_reprendre_echecs()`, `SELECT cump_detecter_obsoletes()`, `SELECT cump_activer_recalcul_automatique(false)`, `SELECT cump_enfiler(ARRAY['${p}']::uuid[], 'reception')`, `SELECT cump_purger_file()`])
          expect(await refuse(db.query(q)), `${role} ${q}`).toMatch(/permission denied/);
        await db.exec('RESET ROLE');
      }
      await db.exec('SET ROLE service_role'); await rec(db, p, 10, 5, '2026-06-15'); expect((await file(db)).length).toBe(1); await traiter(db); expect((await un(db, `SELECT cump_etat_file() e`)).e.reussi_24h).toBe(1);
      await db.exec('RESET ROLE');
      const f = await exec(db, `SELECT proname, prosecdef, proconfig::text c, proacl::text a FROM pg_proc WHERE proname LIKE 'cump\\_trg\\_%' OR proname IN ('cump_enfiler','cump_auto_actif')`);
      expect(f.length).toBe(6); for (const x of f) { expect(x.prosecdef).toBe(true); expect(x.c).toContain('search_path'); expect(x.a).not.toMatch(/anon|authenticated|(^\{|,)=X/); }
      expect((await un(db, `SELECT reloptions::text o FROM pg_class WHERE relname='cump_marges_lignes_suivi'`)).o).toContain('security_invoker=true');
    } finally { await db.close(); }
  });

  test('la migration seule (interrupteur off) ne change aucun comportement : mêmes données qu\'avec les opérations sans migration ; migration rejouable ; fonctions existantes inchangées', async () => {
    const scenario = async (db: PGlite) => {
      const p = await produit(db, 'Produit témoin', 0); const r = await rec(db, p, 100, 8, '2026-06-15'); await rec(db, p, 50, 12, '2026-08-01', false);
      await livrer(db, p, 20, { cree: '2026-07-01T05:00:00Z', livre: '2026-07-02T08:00:00Z' }); await majCout(db, r, p, 110, 9);
      return exec(db, `SELECT p.stock_quantity, p.prix_achat_moyen_ht, (SELECT count(*) FROM stock_reception_items) items, (SELECT sum(quantity) FROM stock_reception_items) q, (SELECT count(*) FROM orders) cmd,
                              (SELECT sum(stock_decremented) FROM order_items) sorties, (SELECT count(*) FROM admin_audit_logs) audit, (SELECT reserved FROM product_availability WHERE product_id=p.id) reserve FROM products p WHERE p.name='Produit témoin'`);
    };
    const sans = await baseAchats(false); await sans.exec(lire('receptions_stock_differentiel.sql')); const ref = await scenario(sans); await sans.close();
    const avec = await base(false); const resultat = await scenario(avec);
    try {
      expect(resultat).toEqual(ref);
      await avec.exec(M2); await avec.exec(M2); expect((await un(avec, `SELECT valeur v FROM cump_config WHERE cle='recalcul_automatique'`)).v).toBe('off');
      expect(await exec(avec, `SELECT * FROM cump_file`)).toHaveLength(0);
    } finally { await avec.close(); }
    const db = await baseAchats(false); await db.exec(lire('receptions_stock_differentiel.sql')); await db.exec(M1);
    try {
      const objets = async () => ({ f: await exec(db, `SELECT proname, md5(pg_get_functiondef(oid)) m FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname NOT LIKE 'cump\\_%' ORDER BY 1,2`),
        t: await exec(db, `SELECT tgname FROM pg_trigger WHERE NOT tgisinternal AND tgname NOT LIKE '%cump%' ORDER BY 1`) });
      const a = await objets(); await db.exec(M2); expect(await objets()).toEqual(a);
    } finally { await db.close(); }
  });

  test('compatibilité avec le correctif de stock et les réceptions partielles (branche non fusionnée), dans les deux ordres : réception libre, réception rattachée à une commande, annulation', async () => {
    let partielles = '';
    try { partielles = execSync('git show feat/achats-receptions-partielles:supabase/migrations/achats_receptions_partielles.sql', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 1 << 26 }); } catch { /* branche absente */ }
    test.skip(!partielles, 'branche des réceptions partielles absente');
    for (const ordre of ['cump_puis_partielles', 'partielles_puis_cump']) {
      const db = await baseAchats(false); await db.exec(lire('receptions_stock_differentiel.sql'));
      try {
        if (ordre === 'cump_puis_partielles') { await db.exec(M1); await db.exec(M2); await db.exec(partielles); } else { await db.exec(partielles); await db.exec(M1); await db.exec(M2); }
        await db.query(`SELECT cump_activer_recalcul_automatique(true)`);
        const p = await produit(db, nom(), 0); const r = await rec(db, p, 100, 10, '2026-06-15'); await traiter(db);
        await majCout(db, r, p, 100, 11, '2026-06-15'); expect(await nbFile(db, 'en_attente'), ordre).toBe(1); await traiter(db);
        await db.query(`INSERT INTO auth.users DEFAULT VALUES`);
        const s = (await un(db, `INSERT INTO shipments (supplier_name, reference, status) VALUES ('F','R-${ordre}','en_transit') RETURNING id`)).id;
        const lie = (await un(db, `INSERT INTO stock_receptions (supplier_name, received_at, stock_applied, shipment_id, cle_idempotence, created_by, created_by_email) VALUES ('F','2026-07-01',true,$1, gen_random_uuid(), (SELECT id FROM auth.users LIMIT 1), 'a@test.local') RETURNING id`, [s])).id;
        await db.query(`SET inca.achats_ecriture='1'`); await db.query(`INSERT INTO stock_reception_items (reception_id, product_id, quantity, unit_cost_ht) VALUES ($1,$2,100,20)`, [lie, p]); await db.query(`RESET inca.achats_ecriture`); await db.query(`UPDATE products SET stock_quantity = stock_quantity + 100 WHERE id=$1`, [p]);
        expect(await nbFile(db, 'en_attente'), ordre).toBe(1);                                                                        // une réception rattachée à une commande dépose aussi une demande
        const v = await livrer(db, p, 150, { cree: '2026-07-10T05:00:00Z', livre: '2026-07-10T08:00:00Z' }); await traiter(db);
        proche(await cout(db, v.it), 15.5);                                                                                           // (100 × 11 + 100 × 20) / 200
        await db.query(`SET inca.achats_ecriture='1'`); await db.query(`UPDATE stock_receptions SET annulee_le = now(), annulee_par = (SELECT id FROM auth.users LIMIT 1), annulation_motif = 'test' WHERE id=$1`, [lie]); await db.query(`RESET inca.achats_ecriture`);
        expect(await nbFile(db, 'en_attente'), ordre).toBe(1);                                                                        // l'annulation dépose une demande
        await traiter(db); expect((await ligne(db, v.it)).fiabilite, ordre).toBe('non_recalculable');                                // la réception annulée sort du calcul
      } finally { await db.close(); }
    }
  });

  test('suivi : état de la file, purge des demandes terminées anciennes (l\'historique des corrections n\'est jamais purgé)', async () => {
    const db = await base();
    try {
      const p = await produit(db, nom(), 0); await rec(db, p, 10, 5, '2026-06-15'); await traiter(db);
      await db.query(`SELECT cump_recalculer_produits(ARRAY['${p}']::uuid[], 'manuel')`);
      await db.query(`UPDATE cump_file SET termine_le = now() - interval '200 days'`);
      expect((await un(db, `SELECT cump_purger_file(90) n`)).n).toBe(1); expect(await file(db)).toHaveLength(0);
      expect((await un(db, `SELECT count(*)::int n FROM cump_recalculs`)).n).toBe(1);
      expect((await un(db, `SELECT cump_etat_file() e`)).e).toMatchObject({ automatique: true, en_attente: 0, echoue: 0 });
    } finally { await db.close(); }
  });
});
