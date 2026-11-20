/**
 * Rattrapage quotidien du CUMP (/api/cron/cump + src/lib/cump.ts) : reprise des demandes en échec, balayage des produits obsolètes, traitement de la file, authentification stricte.
 * Les scénarios « base » s'exécutent sur la vraie base PGlite (vraies migrations du dépôt) à travers le même client RPC que la route ; aucune connexion distante.
 * Les accès réellement simultanés (plusieurs connexions) sont testés par supabase/controles/concurrence_cump.mjs.
 */
import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import type { PGlite } from '@electric-sql/pglite';
import { baseAchats, lire, un, exec, produit } from './helpers/receptionsBase';
import { rattrapageCump, secretCronValide, oublierAbsenceCump, type ClientRpc } from '../src/lib/cump';

const src = (f: string) => readFileSync(f, 'utf8').replace(/\r\n/g, '\n');
const M1 = lire('cump_glissant.sql'); const V2 = lire('cump_methode_v2.sql'); const M2 = lire('cump_recalcul_automatique.sql');
let n = 0; const nom = () => `Produit cron ${++n}`;
test.beforeEach(() => oublierAbsenceCump());

async function base(): Promise<PGlite> {
  const db = await baseAchats(false); await db.exec(lire('receptions_stock_differentiel.sql')); await db.exec(M1); await db.exec(V2); await db.exec(M2);
  await db.query(`SELECT cump_activer_recalcul_automatique(true)`); return db;
}
/** Même interface que supabaseAdmin.rpc : appelle la vraie fonction SQL avec des arguments nommés. */
const client = (db: PGlite, avant?: (fn: string) => Promise<void> | void): ClientRpc & { appels: string[] } => {
  const appels: string[] = [];
  return { appels, rpc: async (fn: string, args: Record<string, unknown> = {}) => {
    appels.push(fn); await avant?.(fn);
    const cles = Object.keys(args);
    try { const r = await db.query(`SELECT ${fn}(${cles.map((k, i) => `${k} => $${i + 1}`).join(', ')}) r`, cles.map(k => args[k])); return { data: (r.rows[0] as any).r, error: null }; }
    catch (e: any) { return { data: null, error: { message: e.message } }; }
  } };
};
const rec = async (db: PGlite, p: string, q: number, c: number, date: string) =>
  (await un(db, `SELECT reception_create('F', $1::date, NULL, true, $2::jsonb) id`, [date, JSON.stringify([{ product_id: p, quantity: q, unit_cost_ht: c }])])).id as string;
async function livrer(db: PGlite, p: string, qty: number, cree: string, livre: string) {
  const snap = (await un(db, `SELECT prix_achat_moyen_ht s FROM products WHERE id=$1`, [p])).s;
  const cmd = (await un(db, `INSERT INTO orders (status, created_at) VALUES ('en_attente', $1::timestamptz) RETURNING id`, [cree])).id as string;
  const it = (await un(db, `INSERT INTO order_items (order_id, product_id, product_name, quantity, price_ht_snapshot, pump_snapshot) VALUES ($1,$2,'x',$3,20,$4) RETURNING id`, [cmd, p, qty, snap])).id as string;
  await db.query(`UPDATE orders SET status='livree' WHERE id=$1`, [cmd]); await db.query(`SELECT * FROM order_mark_livree($1)`, [cmd]);
  await db.query(`INSERT INTO admin_audit_logs (admin_email, action, target_type, target_id, details, created_at) VALUES ('a@x.local','commande.statut','order',$1,$2::jsonb,$3::timestamptz)`, [cmd, JSON.stringify({ ancien: 'en_attente', nouveau: 'livree' }), livre]);
  return { cmd, it };
}
const coutDe = async (db: PGlite, it: string) => { const l = await un(db, `SELECT cout_cump FROM cump_sorties WHERE order_item_id=$1`, [it]); return l?.cout_cump == null ? null : Number(l.cout_cump); };
const nbFile = async (db: PGlite, statut: string) => (await un(db, `SELECT count(*)::int n FROM cump_file WHERE statut=$1`, [statut])).n as number;
async function empreinteCommerciale(db: PGlite) {
  const tables = (await exec(db, `SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE' AND table_name NOT LIKE 'cump\\_%' AND table_name <> 'admin_audit_logs' ORDER BY 1`)).map((r: any) => r.table_name as string);
  const out: Record<string, string> = {};
  for (const t of tables) out[t] = (await un(db, `SELECT md5(coalesce(string_agg(to_jsonb(x)::text, ',' ORDER BY to_jsonb(x)::text), '')) h FROM "${t}" x`)).h;
  return out;
}
const PANNE = `CREATE FUNCTION panne_cump() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF coalesce(current_setting('inca.panne_cump', true), '') = '1' THEN RAISE EXCEPTION 'panne simulée du calcul'; END IF; RETURN NEW; END $$;
  CREATE TRIGGER trg_panne_cump BEFORE INSERT OR UPDATE ON cump_sorties FOR EACH ROW EXECUTE FUNCTION panne_cump();
  CREATE TRIGGER trg_panne_cump_etat BEFORE INSERT OR UPDATE ON cump_etat_produit FOR EACH ROW EXECUTE FUNCTION panne_cump();`;

test.describe('Authentification stricte par CRON_SECRET', () => {
  const S = 'secret-de-test-0123456789';
  test('absent, vide, trop court, incorrect, autre schéma ou en-tête absent : refus ; secret correct : accepté', () => {
    expect(secretCronValide(S, `Bearer ${S}`)).toBe(true);
    expect(secretCronValide(undefined, `Bearer ${S}`)).toBe(false); expect(secretCronValide('', 'Bearer ')).toBe(false); expect(secretCronValide('', '')).toBe(false);
    expect(secretCronValide('court', 'Bearer court')).toBe(false);                                   // moins de 16 caractères : refusé même si identique
    expect(secretCronValide(S, 'Bearer autre-secret-0123456789')).toBe(false); expect(secretCronValide(S, S)).toBe(false); expect(secretCronValide(S, `Basic ${S}`)).toBe(false);
    expect(secretCronValide(S, '')).toBe(false); expect(secretCronValide(S, undefined)).toBe(false); expect(secretCronValide(S, `Bearer ${S} `)).toBe(false); expect(secretCronValide(S, `bearer ${S}`)).toBe(false);
  });

  test('la route vérifie le secret AVANT tout accès à la base ; planification : une seule entrée, 22 h 30 UTC, vers cette route ; aucune autre route de la tâche', () => {
    const r = src('src/pages/api/cron/cump.ts');
    expect(r).toContain('export const GET'); expect(r).not.toContain('export const POST');
    expect(r.indexOf('secretCronValide(secret, fourni)')).toBeGreaterThan(-1); expect(r.indexOf("'Non autorisé', { status: 401 }")).toBeGreaterThan(-1);
    expect(r.indexOf('secretCronValide(secret, fourni)')).toBeLessThan(r.indexOf('rattrapageCump('));
    expect(r.indexOf('secretCronValide(secret, fourni)')).toBeLessThan(r.indexOf('supabaseAdmin as any'));
    expect(JSON.parse(readFileSync('vercel.json', 'utf8')).crons).toEqual([{ path: '/api/cron/cump', schedule: '30 22 * * *' }]);
    expect(src('vercel.json')).toContain('Content-Security-Policy');                                  // les en-têtes de sécurité existants sont conservés
  });
});

test.describe('rattrapageCump : étapes, isolation, journal', () => {
  test('ordre : état (avant), reprise puis traitement, balayage puis traitement ; file vide : rien n\'est journalisé', async () => {
    const ordre: string[] = []; const journal: any[] = [];
    const r = await rattrapageCump({ rpc: async (fn) => { ordre.push(fn); return { data: fn === 'cump_etat_file' ? { echoue: 0, dernieres_erreurs: [] } : fn === 'cump_detecter_obsoletes' ? 0 : { traitees: 0 }, error: null }; } }, async d => { journal.push(d); });
    expect(ordre).toEqual(['cump_etat_file', 'cump_reprendre_echecs', 'cump_traiter_file', 'cump_detecter_obsoletes', 'cump_traiter_file']);
    expect(r).toMatchObject({ ok: true, erreursAvant: [], echouesAvant: 0 }); expect(journal).toHaveLength(0);
  });

  test('une étape en erreur n\'empêche pas l\'autre ; le résultat est un échec (503), tracé au journal ; une erreur du journal ne casse rien', async () => {
    const erreurs: string[] = []; const avant = console.error; console.error = (...a: any[]) => { erreurs.push(a.join(' ')); };
    try {
      const journal: any[] = []; const appels: string[] = [];
      const r = await rattrapageCump({ rpc: async (fn) => { appels.push(fn); return fn === 'cump_reprendre_echecs' ? { data: null, error: { message: 'boom' } } : { data: fn === 'cump_etat_file' ? { echoue: 1, dernieres_erreurs: [{ derniere_erreur: 'x' }] } : 0, error: null }; } }, async d => { journal.push(d); });
      expect(appels).toContain('cump_detecter_obsoletes'); expect(r.ok).toBe(false); expect(r.reprise).toMatchObject({ ok: false, erreur: 'boom' });
      expect(journal).toHaveLength(1); expect(journal[0]).toMatchObject({ echoues_avant: 1, ok: false });
      const r2 = await rattrapageCump({ rpc: async () => ({ data: { echoue: 1, dernieres_erreurs: [1] }, error: null }) }, async () => { throw new Error('journal indisponible'); });
      expect(r2.ok).toBe(true); expect(erreurs.some(e => e.includes('journal du rattrapage'))).toBe(true);
      const r3 = await rattrapageCump({ rpc: async () => { throw new Error('réseau'); } }); expect(r3.ok).toBe(false);                    // ne lève jamais
    } finally { console.error = avant; }
  });

  test('budget de temps dépassé : le balayage est reporté (signalé), jamais interrompu à moitié', async () => {
    const appels: string[] = [];
    const r = await rattrapageCump({ rpc: async (fn) => { appels.push(fn); await new Promise(res => setTimeout(res, 30)); return { data: fn === 'cump_etat_file' ? { echoue: 0 } : 0, error: null }; } }, undefined, 10);
    expect(appels).not.toContain('cump_detecter_obsoletes'); expect(r.ok).toBe(false); expect(r.ignore).toContain('reporté');
  });

  test('migration absente : sans effet, sans erreur', async () => {
    const r = await rattrapageCump({ rpc: async () => ({ data: null, error: { code: 'PGRST202', message: 'Could not find the function public.cump_etat_file' } }) });
    expect(r).toMatchObject({ ok: true, absent: true });
  });
});

test.describe('Scénarios sur la vraie base', () => {
  test('file vide : rien ne change (ni données commerciales, ni tables CUMP, ni journal des corrections, ni file) ; rejouer est sans effet', async () => {
    const db = await base();
    try {
      const p = await produit(db, nom(), 0); await rec(db, p, 100, 8, '2026-06-15'); const v = await livrer(db, p, 10, '2026-07-01T05:00:00Z', '2026-07-02T08:00:00Z');
      await db.query(`SELECT cump_traiter_file()`); const c0 = await coutDe(db, v.it);
      const avant = await empreinteCommerciale(db); const fileAvant = (await un(db, `SELECT count(*)::int n FROM cump_file`)).n; const journalAvant = (await un(db, `SELECT count(*)::int n FROM cump_recalculs`)).n;
      const j: any[] = [];
      for (let i = 0; i < 2; i++) { const r = await rattrapageCump(client(db), async d => { j.push(d); }); expect(r).toMatchObject({ ok: true, echouesAvant: 0 }); }
      expect(j).toHaveLength(0); expect(await empreinteCommerciale(db)).toEqual(avant); expect((await un(db, `SELECT count(*)::int n FROM cump_file`)).n).toBe(fileAvant);
      expect((await un(db, `SELECT count(*)::int n FROM cump_recalculs`)).n).toBe(journalAvant); expect(await coutDe(db, v.it)).toBe(c0);
    } finally { await db.close(); }
  });

  test('demande en attente (aucun utilisateur) : traitée ; produit modifié hors application (sans demande) : retrouvé par le balayage et recalculé', async () => {
    const db = await base();
    try {
      const p = await produit(db, nom(), 0); await rec(db, p, 100, 8, '2026-06-15'); await rec(db, p, 100, 12, '2026-07-10');
      const v = await livrer(db, p, 150, '2026-07-11T05:00:00Z', '2026-07-12T08:00:00Z');
      expect(await nbFile(db, 'en_attente')).toBe(1);
      const r = await rattrapageCump(client(db)); expect(r.ok).toBe(true);
      expect(await nbFile(db, 'en_attente')).toBe(0); expect(await coutDe(db, v.it)).toBeCloseTo((100 * 8 + 100 * 12) / 200, 9);
      // modification sans demande (déclencheurs retirés = écriture hors application) : le balayage la détecte
      await db.exec(`ALTER TABLE stock_reception_items DISABLE TRIGGER trg_cump_lignes_reception; ALTER TABLE stock_receptions DISABLE TRIGGER trg_cump_receptions`);
      await rec(db, p, 50, 20, '2026-07-05'); await db.exec(`ALTER TABLE stock_reception_items ENABLE TRIGGER trg_cump_lignes_reception; ALTER TABLE stock_receptions ENABLE TRIGGER trg_cump_receptions`);
      expect(await nbFile(db, 'en_attente')).toBe(0);
      const r2 = await rattrapageCump(client(db)); expect(r2).toMatchObject({ ok: true }); expect(r2.balayage?.resultat).toMatchObject({ redeposees: 1 });
      expect(await nbFile(db, 'en_attente')).toBe(0); expect(await coutDe(db, v.it)).toBeCloseTo((100 * 8 + 50 * 20 + 100 * 12) / 250, 9);
    } finally { await db.close(); }
  });

  test('demande en échec : reprise sans doublon, erreur relevée AVANT effacement (journal d\'audit), résultat identique à un calcul sans panne ; rejouer est sans effet', async () => {
    const db = await base();
    try {
      const p = await produit(db, nom(), 0); await rec(db, p, 100, 8, '2026-06-15'); await rec(db, p, 100, 12, '2026-07-10'); await db.query(`SELECT cump_traiter_file()`);
      const v = await livrer(db, p, 150, '2026-07-11T05:00:00Z', '2026-07-12T08:00:00Z');
      await db.exec(PANNE); await db.exec(`SET inca.panne_cump = '1'`);
      for (let i = 0; i < 5; i++) { await db.query(`UPDATE cump_file SET disponible_apres = now() WHERE statut='en_attente'`); await db.query(`SELECT cump_traiter_file()`); }
      expect(await nbFile(db, 'echoue')).toBe(1); expect(await coutDe(db, v.it)).toBeNull();
      // la tâche passe alors que la panne dure encore : elle échoue proprement, sans doublon, sans rien casser
      const j: any[] = [];
      const pendant = await rattrapageCump(client(db), async d => { j.push(d); }); expect(pendant.ok).toBe(true);                       // reprise acceptée, nouveau calcul en échec reprogrammé : pas d'erreur de la tâche
      expect(await coutDe(db, v.it)).toBeNull(); expect((await un(db, `SELECT count(*)::int n FROM cump_file WHERE product_id=$1 AND statut IN ('en_attente','echoue')`, [p])).n).toBe(1);

      await db.exec(`SET inca.panne_cump = '0'`); await db.query(`UPDATE cump_file SET disponible_apres = now() WHERE statut='en_attente'`);
      const fichesAvant = (await un(db, `SELECT count(*)::int n FROM cump_file`)).n;
      const r = await rattrapageCump(client(db), async d => { j.push(d); }); expect(r.ok).toBe(true);
      expect(j.length).toBeGreaterThan(0); expect(JSON.stringify(j)).toContain('panne simulée');                                         // l'historique de l'erreur survit à la reprise réussie
      expect(await coutDe(db, v.it)).toBeCloseTo((100 * 8 + 100 * 12) / 200, 9); expect(await nbFile(db, 'echoue')).toBe(0); expect(await nbFile(db, 'en_attente')).toBe(0);
      expect((await un(db, `SELECT count(*)::int n FROM cump_sorties WHERE product_id=$1`, [p])).n).toBe(1);
      expect((await un(db, `SELECT count(*)::int n FROM cump_file`)).n).toBeGreaterThanOrEqual(fichesAvant);                           // les lignes de la file ne sont jamais supprimées
      // rejouer : rien de nouveau
      const jn = j.length; const apres = await empreinteCommerciale(db); const f = (await un(db, `SELECT count(*)::int n FROM cump_file`)).n;
      const r2 = await rattrapageCump(client(db), async d => { j.push(d); }); expect(r2.ok).toBe(true); expect(j.length).toBe(jn);
      expect((await un(db, `SELECT count(*)::int n FROM cump_file`)).n).toBe(f); expect(await empreinteCommerciale(db)).toEqual(apres);
    } finally { await db.close(); }
  });

  test('calcul interrompu (connexion coupée avant la validation) : aucun résultat partiel, la demande reste ; le passage suivant aboutit au même résultat qu\'un passage sans coupure', async () => {
    const db = await base(); const temoin = await base();
    try {
      const mk = async (d: PGlite) => { const p = await produit(d, 'Produit coupure', 0); await rec(d, p, 100, 8, '2026-06-15'); return { p, v: await livrer(d, p, 10, '2026-07-01T05:00:00Z', '2026-07-02T08:00:00Z') }; };
      const { p, v } = await mk(db); const t = await mk(temoin);
      let coupe = false; let coupureActive = true;
      const cli: ClientRpc = { rpc: async (fn: string, args: Record<string, unknown> = {}) => {
        if (fn === 'cump_traiter_file' && coupureActive) { coupe = true; await db.exec('BEGIN'); await db.query(`SELECT cump_traiter_file()`); await db.exec('ROLLBACK'); return { data: null, error: { message: 'connexion coupée' } }; }
        return client(db).rpc(fn, args);
      } };
      const erreurs: string[] = []; const avant = console.error; console.error = (...a: any[]) => { erreurs.push(a.join(' ')); };
      try { const r1 = await rattrapageCump(cli); expect(r1.ok).toBe(false); } finally { console.error = avant; coupureActive = false; }
      expect(coupe).toBe(true); expect(await coutDe(db, v.it)).toBeNull(); expect(await nbFile(db, 'en_attente')).toBe(1);
      const r2 = await rattrapageCump(client(db)); expect(r2.ok).toBe(true);
      await rattrapageCump(client(temoin));
      expect(await coutDe(db, v.it)).toBe(await coutDe(temoin, t.v.it)); expect(await coutDe(db, v.it)).toBeCloseTo(8, 9); expect(p).toBeTruthy();
    } finally { await db.close(); await temoin.close(); }
  });

  test('deux appels simultanés de la tâche : une seule demande par produit, aucun doublon de ligne ni de journal, même résultat qu\'un appel seul', async () => {
    const db = await base(); const seul = await base();
    try {
      const mk = async (d: PGlite) => { const out: string[] = []; for (let i = 0; i < 4; i++) { const p = await produit(d, `Produit simultané ${i}`, 0); await rec(d, p, 100, 8 + i, '2026-06-15'); await rec(d, p, 100, 12, '2026-07-10'); out.push((await livrer(d, p, 150, '2026-07-11T05:00:00Z', '2026-07-12T08:00:00Z')).it); } return out; };
      const items = await mk(db); const itemsSeul = await mk(seul);
      const [a, b] = await Promise.all([rattrapageCump(client(db)), rattrapageCump(client(db))]);
      expect(a.ok && b.ok).toBe(true); await rattrapageCump(client(seul));
      expect(await nbFile(db, 'en_attente')).toBe(0); expect(await nbFile(db, 'echoue')).toBe(0);
      expect((await un(db, `SELECT count(*)::int n, count(DISTINCT product_id)::int d FROM cump_file WHERE statut='reussi'`))).toEqual({ n: 4, d: 4 });
      expect((await un(db, `SELECT count(*)::int n FROM cump_sorties`)).n).toBe(4); expect((await un(db, `SELECT count(*)::int n, count(DISTINCT order_item_id)::int d FROM cump_sorties`))).toEqual({ n: 4, d: 4 });
      expect((await un(db, `SELECT count(*)::int n FROM cump_recalculs`)).n).toBe((await un(seul, `SELECT count(*)::int n FROM cump_recalculs`)).n);
      for (let i = 0; i < 4; i++) expect(await coutDe(db, items[i])).toBe(await coutDe(seul, itemsSeul[i]));
    } finally { await db.close(); await seul.close(); }
  });

  test('le rattrapage n\'écrit que dans cump_* (et la trace du journal d\'audit) : stock, commandes, réceptions, factures, TVA, pump_snapshot inchangés', async () => {
    const db = await base();
    try {
      const p = await produit(db, nom(), 0); await rec(db, p, 100, 8, '2026-06-15'); await livrer(db, p, 10, '2026-07-01T05:00:00Z', '2026-07-02T08:00:00Z');
      const avant = await empreinteCommerciale(db); await rattrapageCump(client(db)); expect(await empreinteCommerciale(db)).toEqual(avant);
    } finally { await db.close(); }
  });
});
