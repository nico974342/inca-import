/**
 * Écran « Portefeuilles » de bout en bout : actions de l'interface → bibliothèque → VRAIES fonctions SQL de la migration M1 (base locale PGlite).
 * Aucune connexion à Supabase, aucune écriture en production.
 */
import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { creerPortefeuille, ventilerCA, type DepotPortefeuille } from '../src/lib/portefeuille';
import { traiterAction } from '../src/lib/portefeuillesActions';
import { decrireJournal } from '../src/lib/portefeuillesVue';

const M1 = readFileSync('supabase/migrations/crm_attribution.sql', 'utf8');
const ID = (n: number) => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`;
const ADMIN = { id: ID(1), email: 'admin@inca.re', app_metadata: { role: 'admin' } };
const CLEMENT = { id: ID(2), email: 'clement@inca.re', app_metadata: { role: 'commercial' } };
const ARNAUD = { id: ID(6), email: 'arnaud@inca.re', app_metadata: { role: 'admin' } };
const AUTRE_COMMERCIAL = { id: ID(7), email: 'marie@inca.re', app_metadata: { role: 'commercial' } };
const CLIENT = { id: ID(3), email: 'client@x.fr', app_metadata: { role: 'client' } };
const ANNUAIRE: Record<string, any> = Object.fromEntries([ADMIN, CLEMENT, ARNAUD, AUTRE_COMMERCIAL, CLIENT].map(u => [u.id, u]));

const SCHEMA = `
  CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN BYPASSRLS;
  GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
  ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
  CREATE TABLE client_accounts (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), nom text NOT NULL, societe text, email text, status text,
    CONSTRAINT client_accounts_email_key UNIQUE (email), CONSTRAINT client_accounts_status_check CHECK (status = ANY (ARRAY['prospect','en_attente','actif','suspendu'])));
  CREATE TABLE orders (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid, nom text, societe text, telephone text, email text, status text DEFAULT 'en_attente',
    notes text, created_at timestamptz DEFAULT now(), invoice_path text, tva_rate numeric DEFAULT 0.085);
  CREATE TABLE admin_audit_logs (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), admin_email text NOT NULL, action text NOT NULL, target_type text, target_id text, target_label text, details jsonb, created_at timestamptz NOT NULL DEFAULT now());`;

/** Dépôt branché sur la base locale : appelle les fonctions SQL M1 telles qu'installées ; annuaire en mémoire. */
function depotPglite(db: PGlite): DepotPortefeuille {
  const type = (nom: string) => (/_ids$/.test(nom) ? '::uuid[]' : /_id$/.test(nom) ? '::uuid' : '::text');
  return {
    async rpc(fonction, params) {
      const noms = Object.keys(params);
      const args = noms.map((n, i) => `${n} => $${i + 1}${type(n)}`).join(', ');
      const valeurs = noms.map(n => (Array.isArray(params[n]) ? `{${(params[n] as string[]).join(',')}}` : params[n]));
      try { const r = await db.query<any>(`SELECT ${fonction}(${args}) AS r`, valeurs); return { data: r.rows[0].r, error: null }; }
      catch (e: any) { return { data: null, error: { message: String(e.message ?? e) } }; }
    },
    async trouverCompte(id) { return ANNUAIRE[id] ?? null; },
  };
}
class F { constructor(private d: Record<string, unknown | unknown[]>) {} get(n: string) { const v = this.d[n]; return Array.isArray(v) ? v[0] : v; } getAll(n: string) { const v = this.d[n]; return v === undefined ? [] : Array.isArray(v) ? v : [v]; } }
const form = (d: Record<string, unknown | unknown[]>) => new F({ confirme: 'oui', ...d });
const un = async (db: PGlite, q: string, p: unknown[] = []) => (await db.query<any>(q, p)).rows[0];
const tous = async (db: PGlite, q: string, p: unknown[] = []) => (await db.query<any>(q, p)).rows;

test.describe.serial('Portefeuilles — de l\'écran aux fonctions M1 (base locale)', () => {
  let db: PGlite; let pf: ReturnType<typeof creerPortefeuille>; const c: Record<string, string> = {};
  const agir = (u: any, d: Record<string, unknown | unknown[]>) => traiterAction(pf, u, form(d));
  const audit = async () => (await un(db, `SELECT count(*)::int n FROM admin_audit_logs WHERE action IN ('client.responsable','client.rattachement_groupe')`)).n;
  const commande = async (mel: string) => (await un(db, `INSERT INTO orders (nom, email, status) VALUES ('x', $1, 'livree') RETURNING id`, [mel])).id as string;
  const etatCommande = async (id: string) => un(db, `SELECT client_id, responsable_email, attribution, rattachement_groupe FROM orders WHERE id=$1`, [id]);
  let historique: string[]; let figeesAvant: any[];

  test.beforeAll(async () => {
    db = new PGlite(); await db.exec(SCHEMA);
    const cl = async (cle: string, statut = 'actif') => { c[cle] = (await un(db, `INSERT INTO client_accounts (nom, societe, email, status) VALUES ($1, $1, $2, $3) RETURNING id`, [cle, `${cle}@x.fr`, statut])).id; };
    for (const k of ['c1', 'c2', 'c3', 'c5', 'c6']) await cl(k); await cl('c4', 'prospect');
    historique = [await commande('c1@x.fr'), await commande('c1@x.fr'), await commande('c2@x.fr')];     // commandes passées AVANT M1
    await db.exec(M1);
    pf = creerPortefeuille(depotPglite(db));
    await db.exec(`SELECT set_config('inca.attribution_client', '1', false)`); await db.query(`UPDATE client_accounts SET responsable_id = $1, responsable_email = 'arnaud@inca.re', responsable_depuis = now() WHERE id = $2`, [ARNAUD.id, c.c5]);
    await db.exec(`SELECT set_config('inca.attribution_client', '', false)`);
    figeesAvant = await tous(db, `SELECT id, client_id, responsable_id, responsable_email, attribution, rattachement_groupe FROM orders WHERE id = ANY($1::uuid[]) ORDER BY id`, [`{${historique.join(',')}}`]);
  });
  test.afterAll(async () => { await db.close(); });

  test('l\'administrateur attribue plusieurs clients à Clément en une opération (atomique, journalisée)', async () => {
    const n0 = await audit();
    const r = await agir(ADMIN, { operation: 'attribuer', client_ids: [c.c1, c.c2, c.c3], responsable_id: CLEMENT.id, motif: 'Portefeuille initial' });
    expect(r).toEqual({ ok: true, message: '3 clients attribués — journalisé.' });
    const etat = await tous(db, `SELECT societe, responsable_email FROM client_accounts WHERE id = ANY($1::uuid[]) ORDER BY societe`, [`{${c.c1},${c.c2},${c.c3}}`]);
    expect(etat.every(x => x.responsable_email === 'clement@inca.re')).toBe(true);
    expect(await audit()).toBe(n0 + 3);
    const j = await un(db, `SELECT admin_email, details FROM admin_audit_logs WHERE action='client.responsable' AND target_id=$1`, [c.c1]);
    expect(j.admin_email).toBe('admin@inca.re'); expect(j.details).toMatchObject({ action: 'attribution', role_acteur: 'admin', nouveau: { id: CLEMENT.id, email: 'clement@inca.re' }, motif: 'Portefeuille initial' });
  });

  test('un lot dont un identifiant est inconnu échoue ENTIÈREMENT : aucun changement, aucune ligne de journal', async () => {
    const n0 = await audit();
    const r = await agir(ADMIN, { operation: 'attribuer', client_ids: [c.c6, ID(999)], responsable_id: CLEMENT.id, motif: 'Essai' });
    expect(r).toEqual({ ok: false, message: 'Client introuvable.' });
    expect((await un(db, `SELECT responsable_id FROM client_accounts WHERE id=$1`, [c.c6])).responsable_id).toBeNull();
    expect(await audit()).toBe(n0);
  });

  test('le commercial prend en charge : le client libre réussit, le client déjà attribué est refusé et reste inchangé ; un autre commercial ne peut pas le reprendre', async () => {
    const n0 = await audit();
    const r = await agir(CLEMENT, { operation: 'prendre', client_ids: [c.c4, c.c5, c.c6] });
    expect(r.ok).toBe(true);
    expect(r.message).toBe('2 clients pris en charge — journalisé. 1 refusé : Ce client a déjà un responsable : seul un administrateur peut le transférer.');
    const etat = Object.fromEntries((await tous(db, `SELECT societe, responsable_email FROM client_accounts WHERE societe IN ('c4','c5','c6')`)).map(x => [x.societe, x.responsable_email]));
    expect(etat).toEqual({ c4: 'clement@inca.re', c5: 'arnaud@inca.re', c6: 'clement@inca.re' });
    expect(await audit()).toBe(n0 + 2);
    expect((await agir(AUTRE_COMMERCIAL, { operation: 'prendre', client_ids: [c.c4] })).ok).toBe(false);           // déjà pris : refusé par la base
    expect((await un(db, `SELECT responsable_email FROM client_accounts WHERE id=$1`, [c.c4])).responsable_email).toBe('clement@inca.re');
  });

  test('un commercial ne peut NI transférer NI classer NI retirer : refusé par l\'écran ET par la base (même en contournant l\'écran)', async () => {
    const n0 = await audit();
    for (const d of [{ operation: 'attribuer', responsable_id: CLEMENT.id, motif: 'ok ok' }, { operation: 'retirer', motif: 'ok ok' }, { operation: 'classer', valeur: 'interne' }]) {
      expect((await agir(CLEMENT, { client_ids: [c.c5], ...d })).ok, d.operation).toBe(false);
    }
    // contournement de l'écran : appel direct de la fonction avec le rôle commercial
    expect((await depotPglite(db).rpc('client_attribuer', { p_client_id: c.c5, p_nouveau_id: CLEMENT.id, p_nouveau_email: CLEMENT.email, p_action: 'transfert', p_acteur_id: CLEMENT.id, p_acteur_email: CLEMENT.email, p_acteur_role: 'commercial', p_motif: 'tentative' })).error?.message).toMatch(/ACTION_INTERDITE/);
    expect((await un(db, `SELECT responsable_email FROM client_accounts WHERE id=$1`, [c.c5])).responsable_email).toBe('arnaud@inca.re');
    expect(await audit()).toBe(n0);
  });

  test('transfert, retrait et nouvelles commandes : les commandes passées gardent leur responsable ; les nouvelles portent le responsable DU MOMENT', async () => {
    const avantTransfert = await commande('c1@x.fr');                                                      // c1 est à Clément
    expect(await etatCommande(avantTransfert)).toMatchObject({ responsable_email: 'clement@inca.re', attribution: 'portefeuille' });
    expect(await agir(ADMIN, { operation: 'attribuer', client_ids: [c.c1], responsable_id: ARNAUD.id, motif: 'Réorganisation des portefeuilles' })).toEqual({ ok: true, message: '1 client transféré — journalisé.' });
    const apres = await commande('c1@x.fr');
    expect(await etatCommande(avantTransfert)).toMatchObject({ responsable_email: 'clement@inca.re' });     // inchangée
    expect(await etatCommande(apres)).toMatchObject({ responsable_email: 'arnaud@inca.re', attribution: 'portefeuille' });
    expect(await agir(ADMIN, { operation: 'retirer', client_ids: [c.c2], motif: 'Départ du commercial' })).toEqual({ ok: true, message: '1 responsable retiré — journalisé.' });
    const libre = await commande('c2@x.fr');
    expect(await etatCommande(libre)).toMatchObject({ responsable_email: null, attribution: 'sans_responsable' });
    expect(await agir(ADMIN, { operation: 'retirer', client_ids: [c.c2], motif: 'Encore' })).toMatchObject({ ok: false });   // déjà sans responsable : incohérent, refusé
  });

  test('classement : la fiche change, les commandes passées ne changent JAMAIS, les nouvelles prennent la classification du moment', async () => {
    const avant = await commande('c3@x.fr');                                                               // c3 non classé
    const r = await agir(ADMIN, { operation: 'classer', client_ids: [c.c1, c.c3], valeur: 'interne', motif: 'Validé par la direction' });
    expect(r.message).toBe('2 clients classés « Groupe Incana » — journalisé. Les commandes passées ne changent pas.');
    expect((await tous(db, `SELECT societe, rattachement_groupe g, rattachement_valide_par p FROM client_accounts WHERE id = ANY($1::uuid[]) ORDER BY societe`, [`{${c.c1},${c.c3}}`])).map(x => [x.societe, x.g, x.p])).toEqual([['c1', 'interne', 'admin@inca.re'], ['c3', 'interne', 'admin@inca.re']]);
    expect((await etatCommande(avant)).rattachement_groupe).toBe('non_classe');                            // figée
    const apres = await commande('c3@x.fr');
    expect((await etatCommande(apres)).rattachement_groupe).toBe('interne');
    expect(await agir(ADMIN, { operation: 'classer', client_ids: [c.c3], valeur: 'externe' })).toMatchObject({ ok: true });
    expect((await etatCommande(apres)).rattachement_groupe).toBe('interne');                               // jamais rétroactif
    expect((await etatCommande(await commande('c3@x.fr'))).rattachement_groupe).toBe('externe');
    expect(await agir(ADMIN, { operation: 'classer', client_ids: [c.c3], valeur: 'non_classe' })).toMatchObject({ ok: true });
    expect((await un(db, `SELECT rattachement_groupe g, rattachement_valide_par p FROM client_accounts WHERE id=$1`, [c.c3])).g).toBeNull();
    expect((await agir(CLEMENT, { operation: 'classer', client_ids: [c.c3], valeur: 'interne' })).ok).toBe(false);
  });

  test('HISTORIQUE : les 3 commandes d\'avant M1 sont restées « historique », sans client ni responsable ; leur CA reste dans le global, hors performances individuelles', async () => {
    const apres = await tous(db, `SELECT id, client_id, responsable_id, responsable_email, attribution, rattachement_groupe FROM orders WHERE id = ANY($1::uuid[]) ORDER BY id`, [`{${historique.join(',')}}`]);
    expect(apres).toEqual(figeesAvant);
    expect(apres.every(o => o.attribution === 'historique' && o.rattachement_groupe === 'non_classe' && o.client_id === null && o.responsable_id === null)).toBe(true);
    const v = ventilerCA((await tous(db, `SELECT attribution, responsable_email, rattachement_groupe, 100::float8 AS ca_ht FROM orders`)) as any);
    expect(v.historiqueNonAttribue.commandes).toBe(3);
    expect(v.global).toBe(v.performancesIndividuelles + v.historiqueNonAttribue.ca + v.sansResponsable.ca);
    expect(Object.keys(v.parResponsable)).not.toContain('null');
  });

  test('JOURNAL : chaque changement est lisible dans l\'historique (qui, quoi, motif) et correspond au nombre de changements réels', async () => {
    const lignes = (await tous(db, `SELECT id, admin_email, action, target_id, target_label, details, created_at FROM admin_audit_logs WHERE action IN ('client.responsable','client.rattachement_groupe') ORDER BY created_at, id`)).map(decrireJournal);
    expect(lignes.length).toBe(await audit());
    const textes = lignes.map(l => l.texte);
    expect(textes).toContain('Attribué à clement@inca.re'); expect(textes).toContain('Pris en charge par clement@inca.re');
    expect(textes).toContain('Transféré de clement@inca.re à arnaud@inca.re'); expect(textes).toContain('Responsable retiré (était clement@inca.re)');
    expect(textes).toContain('Classement : Non classé → Groupe Incana'); expect(textes).toContain('Classement : Groupe Incana → Externe');
    expect(lignes.find(l => l.texte.startsWith('Transféré'))).toMatchObject({ par: 'admin@inca.re', motif: 'Réorganisation des portefeuilles' });
    expect(lignes.find(l => l.texte.startsWith('Pris en charge'))?.par).toBe('clement@inca.re');
  });
});
