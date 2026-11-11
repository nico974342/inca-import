/**
 * CRM M2 — saisie des échanges et relances : formulaires → bibliothèque → VRAIES fonctions SQL de M1 et M2 (base locale PGlite).
 * Aucune connexion à Supabase, aucune écriture en production.
 */
import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { creerCrm, ajouterJours, dateValide, echeanceChoisie, lienTelephone, messageCrm, RACCOURCIS } from '../src/lib/crm';
import { traiterActionCrm, adresseRetourCrm } from '../src/lib/crmActions';
import { construireHistorique, dateCourte, dernierContact, etatRelance, libelleEcheance, peutModifierInteraction, prochaineRelance, titreInteraction, type Interaction, type Relance } from '../src/lib/crmVue';
import type { DepotPortefeuille } from '../src/lib/portefeuille';

const lire = (f: string) => readFileSync(`supabase/migrations/${f}`, 'utf8');
const ID = (n: number) => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`;
const ADMIN = { id: ID(1), email: 'admin@inca.re', app_metadata: { role: 'admin' } };
const CLEMENT = { id: ID(2), email: 'clement@inca.re', app_metadata: { role: 'commercial' } };
const MARIE = { id: ID(7), email: 'marie@inca.re', app_metadata: { role: 'commercial' } };
const CLIENT = { id: ID(3), email: 'client@x.fr', app_metadata: { role: 'client' } };
const FAUX_COMMERCIAL = { id: ID(8), email: 'faux@x.fr', app_metadata: {}, user_metadata: { role: 'admin' } };   // rôle écrit par l'utilisateur lui-même : ignoré
const ANNUAIRE: Record<string, any> = Object.fromEntries([ADMIN, CLEMENT, MARIE, CLIENT, FAUX_COMMERCIAL].map(u => [u.id, u]));

// ── Fonctions pures ──────────────────────────────────────────────────────────────────────────────────────────────────────────
test.describe('CRM — dates, téléphone, messages, affichage (fonctions pures)', () => {
  test('raccourcis de date : demain, 3, 7 et 14 jours ; date personnalisée validée ; calcul sans décalage', () => {
    expect(RACCOURCIS.map(r => r.jours)).toEqual([1, 3, 7, 14]);
    expect(echeanceChoisie('demain', '', '2026-11-30')).toBe('2026-12-01');
    expect(echeanceChoisie('3j', '', '2026-12-30')).toBe('2027-01-02');
    expect(echeanceChoisie('7j', '', '2027-02-25')).toBe('2027-03-04');
    expect(echeanceChoisie('14j', '', '2026-11-11')).toBe('2026-11-25');
    expect(echeanceChoisie('date', '2026-12-24', '2026-11-11')).toBe('2026-12-24');
    expect(echeanceChoisie('date', '2026-02-30', '2026-11-11')).toBeNull();
    expect(echeanceChoisie('date', '', '2026-11-11')).toBeNull();
    expect(echeanceChoisie('', '2026-12-24', '2026-11-11')).toBeNull();
    expect(echeanceChoisie('10j', '', '2026-11-11')).toBeNull();
    expect(ajouterJours('2028-02-28', 1)).toBe('2028-02-29');
    expect(dateValide('2026-13-01')).toBe(false);
  });
  test('lien « Appeler » : uniquement un vrai numéro, jamais de caractère injecté', () => {
    expect(lienTelephone('0692 12 34 56')).toBe('tel:0692123456');
    expect(lienTelephone('+262 692 12 34 56')).toBe('tel:+262692123456');
    expect(lienTelephone('06.92.12.34.56')).toBe('tel:0692123456');
    expect(lienTelephone('abc')).toBeNull();
    expect(lienTelephone('')).toBeNull();
    expect(lienTelephone(null)).toBeNull();
    expect(lienTelephone('12')).toBeNull();
    expect(lienTelephone('0692123456;javascript:alert(1)')).toBe('tel:06921234561');   // seuls les chiffres sont conservés
    expect(lienTelephone('1'.repeat(30))).toBeNull();
  });
  test('messages : un code inconnu ne révèle rien ; les codes connus sont en français clair', () => {
    expect(messageCrm('ERROR: ACTION_INTERDITE')).toContain('portefeuille');
    expect(messageCrm('relation "x" does not exist')).toBe("L'opération a échoué : rien n'a été enregistré.");
    expect(messageCrm(null)).toBe("L'opération a échoué : rien n'a été enregistré.");
  });
  test('relances : retard, aujourd\'hui, à venir ; libellés lisibles', () => {
    expect(etatRelance('2026-11-10', '2026-11-11')).toBe('en_retard');
    expect(etatRelance('2026-11-11', '2026-11-11')).toBe('aujourdhui');
    expect(etatRelance('2026-11-12', '2026-11-11')).toBe('a_venir');
    expect(libelleEcheance('2026-11-08', '2026-11-11')).toBe('En retard de 3 jours');
    expect(libelleEcheance('2026-11-10', '2026-11-11')).toBe('En retard de 1 jour');
    expect(libelleEcheance('2026-11-11', '2026-11-11')).toBe("Aujourd'hui");
    expect(libelleEcheance('2026-11-12', '2026-11-11')).toBe('Demain');
    expect(libelleEcheance('2026-11-18', '2026-11-11')).toBe('Dans 7 jours');
    expect(dateCourte('2026-11-18')).toContain('18');
  });
  test('historique : dernier contact sans les activités annulées ; prochaine relance sans les terminées ; chronologie complète avec les commandes', () => {
    const i = (id: string, quand: string, extra: Partial<Interaction> = {}): Interaction => ({ id, type: 'appel', resultat: 'echange', commentaire: null, prochaine_action: null, occurred_at: quand, created_at: quand, created_by: ID(2), created_by_email: 'c@x.fr', nb_modifications: 0, annulee_le: null, annulation_motif: null, ...extra });
    const r = (id: string, ech: string, statut: Relance['statut'], extra: Partial<Relance> = {}): Relance => ({ id, content: 'Rappeler', type: 'relance', echeance: ech, heure: null, assigne_a: ID(2), assigne_email: 'c@x.fr', reports: 0, statut, done_at: null, annulee_le: null, annulation_motif: null, created_at: '2026-11-01T00:00:00Z', ...extra });
    const inters = [i('a', '2026-11-01T10:00:00Z'), i('b', '2026-11-05T10:00:00Z', { annulee_le: '2026-11-05T11:00:00Z', annulation_motif: 'doublon' }), i('c', '2026-11-03T10:00:00Z', { resultat: 'commande_envisagee' })];
    expect(dernierContact(inters)?.id).toBe('c');
    expect(dernierContact([])).toBeNull();
    expect(titreInteraction(inters[2])).toBe('Appel — Commande envisagée');
    const rels = [r('x', '2026-11-20', 'a_faire'), r('y', '2026-11-12', 'faite', { done_at: '2026-11-12T09:00:00Z' }), r('z', '2026-11-15', 'a_faire')];
    expect(prochaineRelance(rels)?.id).toBe('z');
    const h = construireHistorique({ interactions: inters, relances: rels, commandes: [{ id: 'cmd', created_at: '2026-11-04T08:00:00Z', status: 'Livrée', total: 100 }] });
    const idDe = (e: (typeof h)[number]) => (e.genre === 'interaction' ? e.interaction.id : e.genre === 'relance' ? e.relance.id : e.commande.id);
    expect(h.map(idDe)).toEqual(['y', 'b', 'cmd', 'c', 'a']);                                      // relance terminée, activité annulée (toujours visible), commande, échanges
    expect(h.some(e => e.genre === 'relance' && e.relance.statut === 'a_faire')).toBe(false);     // une relance à faire n'est pas dans l'historique : elle est dans « à venir »
    const dates = h.map(e => e.date); expect([...dates].sort().reverse()).toEqual(dates);          // plus récent d'abord
  });
  test('correction : l\'auteur sous 24 h, l\'administrateur toujours, jamais une activité annulée', () => {
    const maintenant = Date.parse('2026-11-11T12:00:00Z');
    const base = { created_by: ID(2), created_at: '2026-11-11T08:00:00Z', annulee_le: null };
    expect(peutModifierInteraction(base, { id: ID(2), role: 'commercial' }, maintenant)).toBe(true);
    expect(peutModifierInteraction({ ...base, created_at: '2026-11-09T08:00:00Z' }, { id: ID(2), role: 'commercial' }, maintenant)).toBe(false);
    expect(peutModifierInteraction(base, { id: ID(7), role: 'commercial' }, maintenant)).toBe(false);
    expect(peutModifierInteraction({ ...base, created_at: '2026-11-01T08:00:00Z' }, { id: ID(1), role: 'admin' }, maintenant)).toBe(true);
    expect(peutModifierInteraction({ ...base, annulee_le: '2026-11-11T09:00:00Z' }, { id: ID(1), role: 'admin' }, maintenant)).toBe(false);
  });
  test('adresse de retour : uniquement fiche client, Aujourd\'hui ou Activités ; jamais une adresse libre', () => {
    const ok = { ok: true, message: 'Fait' };
    expect(adresseRetourCrm(`/admin/clients/${ID(5)}`, ID(5), ok)).toBe(`/admin/clients/${ID(5)}?ok=Fait`);
    expect(adresseRetourCrm('/admin/aujourdhui?x=1&ok=vieux', null, ok)).toBe('/admin/aujourdhui?x=1&ok=Fait');
    expect(adresseRetourCrm('https://evil.example/', ID(5), { ok: false, message: 'Non' })).toBe(`/admin/clients/${ID(5)}?err=Non`);
    expect(adresseRetourCrm('//evil.example', null, ok)).toBe('/admin/aujourdhui?ok=Fait');
    expect(adresseRetourCrm('/admin/clients/../../api', null, ok)).toBe('/admin/aujourdhui?ok=Fait');
  });
});

// ── Intégration ──────────────────────────────────────────────────────────────────────────────────────────────────────────────
const SCHEMA = `
  CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN BYPASSRLS;
  GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
  ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
  ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;
  CREATE TABLE client_accounts (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), nom text NOT NULL, societe text, email text, status text,
    CONSTRAINT client_accounts_email_key UNIQUE (email), CONSTRAINT client_accounts_status_check CHECK (status = ANY (ARRAY['prospect','en_attente','actif','suspendu'])));
  CREATE TABLE orders (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid, nom text, societe text, telephone text, email text, status text DEFAULT 'en_attente',
    notes text, created_at timestamptz DEFAULT now(), invoice_path text, tva_rate numeric DEFAULT 0.085);
  CREATE TABLE admin_audit_logs (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), admin_email text NOT NULL, action text NOT NULL, target_type text, target_id text, target_label text, details jsonb, created_at timestamptz NOT NULL DEFAULT now());
  CREATE TABLE weekly_tasks (id uuid DEFAULT gen_random_uuid() PRIMARY KEY, content text NOT NULL, done boolean NOT NULL DEFAULT false, created_at timestamptz NOT NULL DEFAULT now(), done_at timestamptz);
  ALTER TABLE weekly_tasks ENABLE ROW LEVEL SECURITY;`;

function depotPglite(db: PGlite): DepotPortefeuille {
  const type = (nom: string) => {
    if (/(echeance|expire_le|jusqu_au)$/.test(nom)) return '::date';
    if (/heure$/.test(nom)) return '::time';
    if (nom === 'p_occurred_at') return '::timestamptz';
    if (nom === 'p_principal') return '::boolean';
    if (nom === 'p_cle' || /_id$/.test(nom)) return '::uuid';
    return '::text';
  };
  return {
    async rpc(fonction, params) {
      const noms = Object.keys(params);
      const args = noms.map((n, i) => `${n} => $${i + 1}${type(n)}`).join(', ');
      try { await db.exec('SET ROLE service_role'); const r = await db.query<any>(`SELECT ${fonction}(${args}) AS r`, noms.map(n => params[n])); return { data: r.rows[0].r, error: null }; }
      catch (e: any) { return { data: null, error: { message: String(e.message ?? e) } }; }
      finally { await db.exec('RESET ROLE'); }
    },
    async trouverCompte(id) { return ANNUAIRE[id] ?? null; },
  };
}
class F { constructor(private d: Record<string, unknown | unknown[]>) {} get(n: string) { const v = this.d[n]; return Array.isArray(v) ? v[0] : v; } getAll(n: string) { const v = this.d[n]; return v === undefined ? [] : Array.isArray(v) ? v : [v]; } }
const un = async (db: PGlite, q: string, p: unknown[] = []) => (await db.query<any>(q, p)).rows[0];
const tous = async (db: PGlite, q: string, p: unknown[] = []) => (await db.query<any>(q, p)).rows;

test.describe.serial('CRM — de l\'écran de saisie aux fonctions M2 (base locale)', () => {
  let db: PGlite; let crm: ReturnType<typeof creerCrm>; let AUJ: string; const c: Record<string, string> = {};
  const agir = (u: any, d: Record<string, unknown>) => traiterActionCrm(crm, u, new F({ cle: crypto.randomUUID(), ...d }), AUJ);
  const interactions = async (cl: string) => tous(db, `SELECT * FROM client_interactions WHERE client_id = $1 ORDER BY created_at, id`, [cl]);
  const relancesOuvertes = async (cl: string) => tous(db, `SELECT * FROM weekly_tasks WHERE client_id = $1 AND type <> 'tache' AND statut = 'a_faire' ORDER BY echeance, created_at`, [cl]);
  const compte = async () => un(db, `SELECT (SELECT count(*) FROM client_interactions)::int i, (SELECT count(*) FROM weekly_tasks)::int t`);

  test.beforeAll(async () => {
    db = new PGlite(); await db.exec(SCHEMA);
    await db.exec(lire('crm_attribution.sql')); await db.exec(lire('crm_activites.sql')); await db.exec(lire('crm_activites_droits.sql'));
    await db.query(`INSERT INTO weekly_tasks (content) VALUES ('Tâche générale existante')`);
    crm = creerCrm(depotPglite(db)); AUJ = (await un(db, `SELECT crm_aujourdhui()::text d`)).d;
    for (const k of ['clem', 'marie', 'libre']) c[k] = (await un(db, `INSERT INTO client_accounts (nom, societe, email, status) VALUES ($1, $1, $2, 'actif') RETURNING id`, [`Client ${k}`, `${k}@x.fr`])).id;
    const att = (cl: string, r: any) => db.query(`SELECT client_attribuer($1, $2, $3, 'attribution', $4, $5, 'admin', NULL)`, [cl, r.id, r.email, ADMIN.id, ADMIN.email]);
    await att(c.clem, CLEMENT); await att(c.marie, MARIE);
  });
  test.afterAll(async () => { await db.close(); });

  test('Clément note un appel en quelques choix : résultat + prochaine action + « 3 jours » → activité et relance créées, rattachées au client, à Clément et à son auteur', async () => {
    const r = await agir(CLEMENT, { operation: 'noter', client_id: c.clem, type: 'appel', resultat: 'pas_de_reponse', action: 'rappeler', delai: '3j' });
    expect(r).toEqual({ ok: true, message: 'Échange enregistré · relance programmée.' });
    const [i] = await interactions(c.clem);
    expect(i).toMatchObject({ type: 'appel', resultat: 'pas_de_reponse', commentaire: null, prochaine_action: 'rappeler', created_by: CLEMENT.id, created_by_email: CLEMENT.email, client_libelle: 'Client clem' });
    const [rel] = await relancesOuvertes(c.clem);
    expect(rel).toMatchObject({ type: 'relance', assigne_a: CLEMENT.id, assigne_email: CLEMENT.email, client_id: c.clem, cree_par: CLEMENT.id, content: 'Rappeler' });
    expect(String(rel.echeance.toISOString?.().slice(0, 10) ?? rel.echeance)).toBe(ajouterJours(AUJ, 3));
  });

  test('l\'identité vient de la session : un formulaire qui prétend être administrateur ou un autre utilisateur ne change rien', async () => {
    const r = await agir(CLEMENT, { operation: 'noter', client_id: c.marie, type: 'appel', resultat: 'echange', acteur_id: ADMIN.id, role: 'admin', p_acteur_role: 'admin', acteur_email: ADMIN.email });
    expect(r.ok).toBe(false);
    expect((await interactions(c.marie)).length).toBe(0);
    const ok = await agir(CLEMENT, { operation: 'noter', client_id: c.clem, type: 'note', commentaire: 'Gérant absent jusqu\'à lundi', created_by: MARIE.id, created_by_email: MARIE.email });
    expect(ok.ok).toBe(true);
    const derniere = (await interactions(c.clem)).at(-1);
    expect(derniere.created_by).toBe(CLEMENT.id);
  });

  test('un client, un compte sans rôle ou un rôle écrit par l\'utilisateur lui-même (user_metadata) n\'ont aucun accès', async () => {
    const avant = await compte();
    for (const u of [CLIENT, FAUX_COMMERCIAL, null, undefined, { id: ID(9), email: 'x@x.fr', app_metadata: { role: 'client' } }])
      expect((await agir(u, { operation: 'noter', client_id: c.clem, type: 'appel', resultat: 'echange' })).ok).toBe(false);
    expect(await compte()).toEqual(avant);
  });

  test('double clic ou renvoi réseau (même clé) : une seule activité et une seule relance', async () => {
    const cle = crypto.randomUUID(); const avant = await compte();
    const d = { operation: 'noter', cle, client_id: c.clem, type: 'visite', resultat: 'rdv_pris', action: 'visiter', delai: '7j', heure: '10:30' };
    const a = await traiterActionCrm(crm, CLEMENT, new F(d), AUJ); const b = await traiterActionCrm(crm, CLEMENT, new F(d), AUJ); const c3 = await traiterActionCrm(crm, CLEMENT, new F(d), AUJ);
    expect(a.ok).toBe(true); expect(b).toEqual({ ok: true, message: 'Déjà enregistré (double envoi ignoré).' }); expect(c3.ok).toBe(true);
    const apres = await compte(); expect(apres).toEqual({ i: avant.i + 1, t: avant.t + 1 });
    expect((await un(db, `SELECT type, heure::text h FROM weekly_tasks WHERE cle_idempotence = $1`, [cle]))).toEqual({ type: 'rendez_vous', h: '10:30:00' });
    const p = { operation: 'programmer', cle: crypto.randomUUID(), client_id: c.clem, titre: 'Envoyer le catalogue', delai: 'demain' };
    await traiterActionCrm(crm, CLEMENT, new F(p), AUJ); expect((await traiterActionCrm(crm, CLEMENT, new F(p), AUJ)).message).toBe('Déjà programmée (double envoi ignoré).');
    expect((await tous(db, `SELECT 1 FROM weekly_tasks WHERE content = 'Envoyer le catalogue'`)).length).toBe(1);
  });

  test('relance existante : il faut répondre Oui/Non ; « Non » la garde ; « Oui » la termine ET programme la suivante dans la même opération ; un autre échange ne la ferme jamais', async () => {
    const [rel] = await relancesOuvertes(c.clem); const id = rel.id as string;
    const avant = await compte();
    const sansReponse = await agir(CLEMENT, { operation: 'noter', client_id: c.clem, type: 'appel', resultat: 'echange', relance_id: id });
    expect(sansReponse.ok).toBe(false); expect(sansReponse.message).toContain('terminée');
    expect(await compte()).toEqual(avant);                                                         // rien d'écrit sans réponse explicite
    expect((await agir(CLEMENT, { operation: 'noter', client_id: c.clem, type: 'appel', resultat: 'echange', relance_id: id, cloturer_relance: 'non', action: 'aucune' })).ok).toBe(true);
    expect((await un(db, `SELECT statut FROM weekly_tasks WHERE id=$1`, [id])).statut).toBe('a_faire');
    for (const t of ['visite', 'message'] as const) await agir(CLEMENT, { operation: 'noter', client_id: c.clem, type: t, resultat: 'echange' });
    expect((await un(db, `SELECT statut FROM weekly_tasks WHERE id=$1`, [id])).statut).toBe('a_faire');
    const n0 = (await relancesOuvertes(c.clem)).length;
    const r = await agir(CLEMENT, { operation: 'noter', client_id: c.clem, type: 'appel', resultat: 'echange', relance_id: id, cloturer_relance: 'oui', action: 'rappeler', delai: '14j' });
    expect(r).toEqual({ ok: true, message: 'Échange enregistré · relance terminée · relance programmée.' });
    expect((await un(db, `SELECT statut, interaction_id IS NOT NULL lie FROM weekly_tasks WHERE id=$1`, [id]))).toEqual({ statut: 'faite', lie: true });
    expect((await relancesOuvertes(c.clem)).length).toBe(n0);                                      // une fermée, une nouvelle : le total ne change pas
    // une relance d'un autre client ne peut pas être fermée par erreur
    const autre = (await agir(ADMIN, { operation: 'programmer', client_id: c.marie, delai: 'demain' })).ok; expect(autre).toBe(true);
    const [relMarie] = await relancesOuvertes(c.marie);
    const mauvais = await agir(CLEMENT, { operation: 'noter', client_id: c.clem, type: 'appel', resultat: 'echange', relance_id: relMarie.id, cloturer_relance: 'oui' });
    expect(mauvais.ok).toBe(false); expect((await un(db, `SELECT statut FROM weekly_tasks WHERE id=$1`, [relMarie.id])).statut).toBe('a_faire');
  });

  test('validations de la saisie : résultat requis, précision pour « Autre », date requise avec une action, rien d\'écrit en cas de refus', async () => {
    const avant = await compte();
    const d = { operation: 'noter', client_id: c.clem, type: 'appel' };
    expect((await agir(CLEMENT, { ...d })).message).toContain('résultat');
    expect((await agir(CLEMENT, { ...d, resultat: 'autre' })).message).toContain('Précisez');
    expect((await agir(CLEMENT, { ...d, resultat: 'echange', action: 'rappeler' })).message).toContain('date');
    expect((await agir(CLEMENT, { ...d, resultat: 'echange', action: 'rappeler', delai: 'date', date_perso: '2020-01-01' })).message).toContain('Date invalide');
    expect((await agir(CLEMENT, { ...d, resultat: 'echange', action: 'rappeler', delai: 'date', date_perso: '2026-02-30' })).message).toContain('date');
    expect((await agir(CLEMENT, { ...d, resultat: 'echange', commentaire: 'x'.repeat(2001) })).ok).toBe(false);
    expect((await agir(CLEMENT, { ...d, type: 'sms', resultat: 'echange' })).ok).toBe(false);
    expect((await agir(CLEMENT, { ...d, client_id: 'pas-un-uuid', resultat: 'echange' })).ok).toBe(false);
    expect((await agir(CLEMENT, { ...d, cle: undefined, resultat: 'echange' })).ok).toBe(false);
    expect(await compte()).toEqual(avant);
    expect((await agir(CLEMENT, { ...d, resultat: 'autre', commentaire: 'Veut une offre' })).ok).toBe(true);
    expect((await agir(CLEMENT, { ...d, resultat: 'commande_envisagee', action: 'preparer_commande', delai: 'date', date_perso: AUJ })).ok).toBe(true);   // aujourd'hui est permis
  });

  test('« Commande envisagée » ne crée aucune commande', async () => {
    const avant = (await un(db, `SELECT count(*)::int n FROM orders`)).n;
    await agir(CLEMENT, { operation: 'noter', client_id: c.clem, type: 'appel', resultat: 'commande_envisagee', action: 'preparer_commande', delai: 'demain' });
    expect((await un(db, `SELECT count(*)::int n FROM orders`)).n).toBe(avant);
  });

  test('portefeuille et délégation : refus hors portefeuille ; l\'administrateur autorise explicitement ; la révocation referme', async () => {
    const note = (u: any, cl: string) => agir(u, { operation: 'noter', client_id: cl, type: 'appel', resultat: 'echange' });
    expect((await note(CLEMENT, c.marie)).ok).toBe(false);
    expect((await note(CLEMENT, c.libre)).ok).toBe(false);                                         // client sans responsable : prise en charge d'abord
    expect(await crm.peutAgir(CLEMENT, c.marie)).toBe(false); expect(await crm.peutAgir(CLEMENT, c.clem)).toBe(true); expect(await crm.peutAgir(ADMIN, c.libre)).toBe(true);
    expect((await agir(CLEMENT, { operation: 'delegation_accorder', commercial_id: CLEMENT.id, proprietaire_id: MARIE.id, motif: 'Auto-attribution' })).ok).toBe(false);   // jamais soi-même
    const acc = await agir(ADMIN, { operation: 'delegation_accorder', commercial_id: CLEMENT.id, proprietaire_id: MARIE.id, motif: 'Congés de Marie' });
    expect(acc).toEqual({ ok: true, message: 'Délégation accordée — journalisé.' });
    expect((await note(CLEMENT, c.marie)).ok).toBe(true); expect(await crm.peutAgir(CLEMENT, c.marie)).toBe(true);
    expect((await note(CLEMENT, c.libre)).ok).toBe(false);                                         // la délégation ne couvre pas les autres clients
    expect((await un(db, `SELECT created_by_email FROM client_interactions WHERE client_id=$1`, [c.marie])).created_by_email).toBe(CLEMENT.email);   // l'auteur reste Clément
    const del = await un(db, `SELECT id FROM crm_delegations WHERE revoque_le IS NULL`);
    expect((await agir(CLEMENT, { operation: 'delegation_revoquer', delegation_id: del.id, motif: 'Je me retire' })).ok).toBe(false);
    expect((await agir(ADMIN, { operation: 'delegation_revoquer', delegation_id: del.id, motif: 'Retour de congés' })).ok).toBe(true);
    expect((await note(CLEMENT, c.marie)).ok).toBe(false);
  });

  test('administrateur : programme une action pour Clément ; Clément ne peut pas confier une relance à quelqu\'un d\'autre', async () => {
    const r = await agir(ADMIN, { operation: 'programmer', client_id: c.clem, titre: 'Présenter la nouvelle gamme', delai: '7j', assigne_id: CLEMENT.id });
    expect(r.ok).toBe(true);
    expect(await un(db, `SELECT assigne_email, cree_par_email FROM weekly_tasks WHERE content = 'Présenter la nouvelle gamme'`)).toEqual({ assigne_email: CLEMENT.email, cree_par_email: ADMIN.email });
    expect((await agir(CLEMENT, { operation: 'programmer', client_id: c.clem, delai: '3j', assigne_id: MARIE.id })).ok).toBe(false);
    expect((await agir(ADMIN, { operation: 'programmer', client_id: c.clem, delai: '3j', assigne_id: CLIENT.id })).ok).toBe(false);          // un compte client n'est pas du personnel
    expect((await agir(ADMIN, { operation: 'programmer', client_id: c.clem, delai: '3j', assigne_id: ID(404) })).ok).toBe(false);
  });

  test('report (compté et journalisé), clôture, annulation motivée, réassignation réservée à l\'administrateur', async () => {
    const [rel] = await relancesOuvertes(c.clem); const id = rel.id as string;
    expect((await agir(CLEMENT, { operation: 'reporter', relance_id: id, delai: '7j', motif: 'Client en déplacement' })).ok).toBe(true);
    expect((await un(db, `SELECT reports FROM weekly_tasks WHERE id=$1`, [id])).reports).toBe(1);
    expect((await un(db, `SELECT count(*)::int n FROM admin_audit_logs WHERE action='relance.report' AND target_id=$1`, [id])).n).toBe(1);
    expect((await agir(CLEMENT, { operation: 'cloturer', relance_id: id, statut: 'annulee' })).message).toContain('motif');
    expect((await agir(CLEMENT, { operation: 'reassigner', relance_id: id, assigne_id: MARIE.id, motif: 'Congés' })).ok).toBe(false);
    expect((await agir(ADMIN, { operation: 'reassigner', relance_id: id, assigne_id: MARIE.id, motif: 'Congés de Clément' })).ok).toBe(true);
    expect((await agir(MARIE, { operation: 'cloturer', relance_id: id, statut: 'faite' })).ok).toBe(true);          // celle à qui elle est confiée peut la terminer
    expect((await agir(MARIE, { operation: 'cloturer', relance_id: id, statut: 'faite' })).ok).toBe(false);
  });

  test('correction et annulation d\'une activité : l\'auteur sous 24 h, journalisé ; rien n\'est supprimé', async () => {
    const [i] = await interactions(c.clem); const n0 = (await interactions(c.clem)).length;
    expect((await agir(CLEMENT, { operation: 'corriger', interaction_id: i.id, resultat: 'refus', commentaire: 'A refusé l\'offre', action: 'aucune' })).ok).toBe(true);
    const j = await un(db, `SELECT details FROM admin_audit_logs WHERE action='interaction.correction' AND target_id=$1`, [i.id]);
    expect(j.details.ancien.resultat).toBe('pas_de_reponse'); expect(j.details.nouveau.resultat).toBe('refus');
    expect((await agir(MARIE, { operation: 'corriger', interaction_id: i.id, resultat: 'echange' })).ok).toBe(false);
    expect((await agir(CLEMENT, { operation: 'annuler', interaction_id: i.id, motif: 'ab' })).ok).toBe(false);
    expect((await agir(CLEMENT, { operation: 'annuler', interaction_id: i.id, motif: 'Saisie sur le mauvais client' })).ok).toBe(true);
    expect((await interactions(c.clem)).length).toBe(n0);
    expect((await un(db, `SELECT annulee_par FROM client_interactions WHERE id=$1`, [i.id])).annulee_par).toBe(CLEMENT.email);
  });

  test('interlocuteurs : ajout par le responsable, refus hors portefeuille, suppression journalisée', async () => {
    expect((await agir(CLEMENT, { operation: 'contact', client_id: c.clem, nom: 'Mme Payet', fonction: 'Gérante', telephone: '0692 11 22 33', principal: '1' })).ok).toBe(true);
    expect((await agir(CLEMENT, { operation: 'contact', client_id: c.marie, nom: 'M. Hoarau' })).ok).toBe(false);
    const k = await un(db, `SELECT id FROM client_contacts WHERE client_id=$1`, [c.clem]);
    expect((await agir(CLEMENT, { operation: 'contact_supprimer', contact_id: k.id, client_id: c.clem })).ok).toBe(true);
    expect((await un(db, `SELECT count(*)::int n FROM admin_audit_logs WHERE action='contact.suppression'`)).n).toBe(1);
  });

  test('les tâches générales existantes ne sont pas touchées par le suivi commercial', async () => {
    expect((await tous(db, `SELECT content, type, statut FROM weekly_tasks WHERE content = 'Tâche générale existante'`))).toEqual([{ content: 'Tâche générale existante', type: 'tache', statut: 'a_faire' }]);
    expect((await agir(CLEMENT, { operation: 'inconnue' })).message).toBe('Opération inconnue.');
  });
});
