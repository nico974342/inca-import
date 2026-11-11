/**
 * Écran « Portefeuilles » — logique de vue et d'actions. Tests hors ligne : aucune connexion à Supabase, aucune écriture.
 */
import { test, expect } from '@playwright/test';
import { creerPortefeuille, type DepotPortefeuille } from '../src/lib/portefeuille';
import { traiterAction, adresseRetour, MAX_LOT, MAX_PRISE_EN_CHARGE } from '../src/lib/portefeuillesActions';
import { filtrerLignes, compterFiltres, compterParResponsable, agregerCommandes, decrireJournal, normaliser, ancienneteCommande, parseFiltre, type LigneClient } from '../src/lib/portefeuillesVue';

const ID = (n: number) => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`;
const ADMIN = { id: ID(1), email: 'admin@inca.re', app_metadata: { role: 'admin' } };
const CLEMENT = { id: ID(2), email: 'clement@inca.re', app_metadata: { role: 'commercial' } };
const CLIENT = { id: ID(3), email: 'client@x.fr', app_metadata: { role: 'client' } };

class F { constructor(private d: Record<string, unknown | unknown[]>) {} get(n: string) { const v = this.d[n]; return Array.isArray(v) ? v[0] : v; } getAll(n: string) { const v = this.d[n]; return v === undefined ? [] : Array.isArray(v) ? v : [v]; } }
const form = (d: Record<string, unknown | unknown[]>) => new F({ confirme: 'oui', ...d });

function depot(reponses: Record<string, (p: any) => { data?: unknown; error?: string }> = {}) {
  const appels: { nom: string; params: Record<string, any> }[] = [];
  const annuaire: Record<string, any> = { [ID(1)]: ADMIN, [ID(2)]: CLEMENT, [ID(3)]: CLIENT, [ID(6)]: { id: ID(6), email: 'arnaud@inca.re', app_metadata: { role: 'admin' } } };
  const d: DepotPortefeuille = {
    async rpc(nom, params) { appels.push({ nom, params }); const r = reponses[nom]?.(params) ?? { data: { ok: true } }; return { data: r.data ?? null, error: r.error ? { message: r.error } : null }; },
    async trouverCompte(id) { return annuaire[id] ?? null; },
  };
  return { p: creerPortefeuille(d), appels };
}

const ligne = (n: number, o: Partial<LigneClient> = {}): LigneClient => ({
  id: ID(100 + n), nom: `Nom ${n}`, societe: `Société ${n}`, email: `c${n}@x.fr`, telephone: '0692 00 00 0' + n, status: 'actif', type: null, commune: 'Saint-Denis', created_at: `2026-10-${String(n).padStart(2, '0')}T08:00:00Z`,
  responsable_id: null, responsable_email: null, rattachement_groupe: null, nb_commandes: 0, derniere_commande: null, ...o,
});

test.describe('Portefeuilles — vue (filtres, comptages, historique)', () => {
  const L = [
    ligne(1), ligne(2, { status: 'prospect' }), ligne(3, { responsable_id: ID(2), responsable_email: 'clement@inca.re', rattachement_groupe: 'externe', nb_commandes: 4, derniere_commande: '2026-11-08T10:00:00Z' }),
    ligne(4, { status: 'en_attente', responsable_id: ID(6), responsable_email: 'arnaud@inca.re', rattachement_groupe: 'interne' }), ligne(5, { societe: 'Café Épicerie du Port', commune: 'Saint-Paul' }),
  ];
  test('filtres : non attribués, mes clients, non classés, statuts, classification', () => {
    const ids = (f: any, viewerId: string | null = ID(2)) => filtrerLignes(L, { filtre: f, viewerId }).map(l => l.id);
    expect(ids('tous').length).toBe(5);
    expect(ids('non_attribues')).toEqual([ID(101), ID(102), ID(105)]);
    expect(ids('mes_clients')).toEqual([ID(103)]); expect(ids('mes_clients', null)).toEqual([]);
    expect(ids('non_classes')).toEqual([ID(101), ID(102), ID(105)]);
    expect(ids('prospects')).toEqual([ID(102)]); expect(ids('en_attente')).toEqual([ID(104)]); expect(ids('actifs').length).toBe(3);
    expect(ids('interne')).toEqual([ID(104)]); expect(ids('externe')).toEqual([ID(103)]);
    expect(filtrerLignes(L, { filtre: 'tous', viewerId: null, responsableId: ID(6) }).map(l => l.id)).toEqual([ID(104)]);
    expect(parseFiltre('n\'importe quoi')).toBe('tous'); expect(parseFiltre('non_attribues')).toBe('non_attribues');
  });
  test('recherche tolérante aux accents et à la casse (nom, société, commune, téléphone, responsable)', () => {
    expect(normaliser('  ÉPICERIE Crème ')).toBe('epicerie creme');
    const r = (q: string) => filtrerLignes(L, { filtre: 'tous', q, viewerId: null }).map(l => l.id);
    expect(r('epicerie')).toEqual([ID(105)]); expect(r('SAINT-PAUL')).toEqual([ID(105)]); expect(r('0692 00 00 03')).toEqual([ID(103)]); expect(r('clement')).toEqual([ID(103)]); expect(r('zzz')).toEqual([]);
  });
  test('compteurs des pastilles et répartition par responsable (non attribués en dernier)', () => {
    const c = compterFiltres(L, ID(2));
    expect(c).toMatchObject({ tous: 5, non_attribues: 3, mes_clients: 1, non_classes: 3, prospects: 1, en_attente: 1, actifs: 3, interne: 1, externe: 1 });
    expect(compterParResponsable(L).map(r => [r.email, r.n])).toEqual([['clement@inca.re', 1], ['arnaud@inca.re', 1], [null, 3]]);
  });
  test('commandes par client : annulées exclues, dernière commande ; ancienneté lisible', () => {
    const m = agregerCommandes([{ client_id: 'a', created_at: '2026-11-01T00:00:00Z', status: 'livree' }, { client_id: 'a', created_at: '2026-11-05T00:00:00Z', status: 'livree' }, { client_id: 'a', created_at: '2026-11-09T00:00:00Z', status: 'annulee' }, { client_id: null, created_at: '2026-11-09T00:00:00Z', status: 'livree' }]);
    expect(m.get('a')).toEqual({ nb: 2, derniere: '2026-11-05T00:00:00Z' }); expect(m.size).toBe(1);
    const now = new Date('2026-11-12T12:00:00Z');
    expect(ancienneteCommande(null, now)).toBe('Jamais commandé'); expect(ancienneteCommande('2026-11-12T08:00:00Z', now)).toBe("Commandé aujourd'hui");
    expect(ancienneteCommande('2026-11-11T08:00:00Z', now)).toBe('Dernière commande hier'); expect(ancienneteCommande('2026-11-05T12:00:00Z', now)).toBe('Dernière commande il y a 7 j');
  });
  test('historique : libellés des attributions, transferts, retraits, prises en charge et classements', () => {
    const e = (action: string, details: any) => decrireJournal({ id: 'x', admin_email: 'admin@inca.re', action, target_id: ID(1), target_label: 'Société', details, created_at: '2026-11-12T08:00:00Z' });
    expect(e('client.responsable', { action: 'attribution', nouveau: { email: 'clement@inca.re' }, ancien: { email: null }, motif: 'Portefeuille initial' })).toMatchObject({ texte: 'Attribué à clement@inca.re', motif: 'Portefeuille initial', client: 'Société' });
    expect(e('client.responsable', { action: 'transfert', nouveau: { email: 'arnaud@inca.re' }, ancien: { email: 'clement@inca.re' } }).texte).toBe('Transféré de clement@inca.re à arnaud@inca.re');
    expect(e('client.responsable', { action: 'retrait', ancien: { email: 'clement@inca.re' }, nouveau: { email: null } }).texte).toBe('Responsable retiré (était clement@inca.re)');
    expect(e('client.responsable', { action: 'prise_en_charge', nouveau: { email: 'clement@inca.re' } }).texte).toBe('Pris en charge par clement@inca.re');
    expect(e('client.rattachement_groupe', { ancien: null, nouveau: 'interne' }).texte).toBe('Classement : Non classé → Groupe Incana');
  });
});

test.describe('Portefeuilles — actions (identité, confirmation, droits)', () => {
  test('sans confirmation, sans sélection, trop de clients, opération inconnue, compte non autorisé : refus SANS appel à la base', async () => {
    const { p, appels } = depot();
    expect((await traiterAction(p, ADMIN, new F({ operation: 'attribuer', client_ids: [ID(10)], responsable_id: ID(2), motif: 'ok ok' }))).message).toMatch(/Confirmez/);     // pas de « confirme »
    expect((await traiterAction(p, ADMIN, form({ operation: 'attribuer', responsable_id: ID(2), motif: 'ok ok' }))).message).toMatch(/Sélectionnez/);
    expect((await traiterAction(p, ADMIN, form({ operation: 'attribuer', client_ids: Array.from({ length: MAX_LOT + 1 }, (_, i) => ID(i + 1000)), responsable_id: ID(2), motif: 'ok ok' }))).message).toMatch(/trop grande/);
    expect((await traiterAction(p, ADMIN, form({ operation: 'bricoler', client_ids: [ID(10)] }))).message).toMatch(/inconnue/);
    for (const u of [CLIENT, null, undefined, { id: ID(9), email: 'x@x.fr', app_metadata: {}, user_metadata: { role: 'admin' } }]) {
      expect((await traiterAction(p, u as any, form({ operation: 'prendre', client_ids: [ID(10)] }))).ok).toBe(false);
    }
    expect((await traiterAction(p, ADMIN, form({ operation: 'attribuer', client_ids: [ID(10)], responsable_id: ID(2), confirme: 'non', motif: 'ok ok' }))).ok).toBe(false);
    expect(appels).toEqual([]);
  });

  test('attribuer / transférer (administrateur) : motif obligatoire, responsable vérifié dans l\'annuaire, un seul lot atomique, message précis', async () => {
    const { p, appels } = depot({ clients_attribuer_lot: () => ({ data: { attribues: 3, transferes: 1, ignores: 2 } }) });
    expect((await traiterAction(p, ADMIN, form({ operation: 'attribuer', client_ids: [ID(10)], responsable_id: ID(2) }))).message).toMatch(/motif/);
    expect((await traiterAction(p, ADMIN, form({ operation: 'attribuer', client_ids: [ID(10)], responsable_id: ID(3), motif: 'ok ok' }))).message).toBe('Responsable invalide.');   // un client n'est pas un responsable possible
    expect(appels).toEqual([]);
    const r = await traiterAction(p, ADMIN, form({ operation: 'attribuer', client_ids: [ID(10), ID(11), ID(10)], responsable_id: ID(2), motif: '  Portefeuille   initial ' }));
    expect(r).toEqual({ ok: true, message: '3 clients attribués · 1 client transféré · 2 clients déjà confiés à cette personne — journalisé.' });
    expect(appels).toHaveLength(1);
    expect(appels[0]).toEqual({ nom: 'clients_attribuer_lot', params: { p_client_ids: [ID(10), ID(11)], p_nouveau_id: ID(2), p_nouveau_email: 'clement@inca.re', p_acteur_id: ID(1), p_acteur_email: 'admin@inca.re', p_acteur_role: 'admin', p_motif: 'Portefeuille initial' } });
  });

  test('un commercial ne peut NI attribuer, NI transférer, NI retirer, NI classer : refus avant la base', async () => {
    const { p, appels } = depot();
    for (const f of [{ operation: 'attribuer', responsable_id: ID(2), motif: 'ok ok' }, { operation: 'retirer', motif: 'ok ok' }, { operation: 'classer', valeur: 'interne' }]) {
      expect((await traiterAction(p, CLEMENT, form({ client_ids: [ID(10)], ...f }))).ok, f.operation).toBe(false);
    }
    expect(appels).toEqual([]);
  });

  test('COUCHE DE L\'ÉCRAN isolée : même avec une bibliothèque qui accepterait tout, un commercial n\'atteint JAMAIS attribuer, retirer ni classer', async () => {
    const appels: string[] = [];
    const permissif: any = {
      attribuerClientsEnLot: async () => { appels.push('lot'); return { ok: true, data: { attribues: 1, transferes: 0, ignores: 0 } }; },
      attribuerClient: async (a: any) => { appels.push(a.action); return { ok: true, data: {} }; },
      classerClientsEnLot: async () => { appels.push('classer'); return { ok: true, data: { classes: 1, inchanges: 0 } }; },
    };
    for (const d of [{ operation: 'attribuer', responsable_id: ID(2), motif: 'ok ok' }, { operation: 'retirer', motif: 'ok ok' }, { operation: 'classer', valeur: 'interne', motif: 'ok ok' }]) {
      expect((await traiterAction(permissif, CLEMENT, form({ client_ids: [ID(10)], ...d }))).ok, d.operation).toBe(false);
    }
    expect(appels).toEqual([]);
    // et l'administrateur, lui, passe (le contrôle ne bloque pas à tort)
    expect((await traiterAction(permissif, ADMIN, form({ client_ids: [ID(10)], operation: 'classer', valeur: 'interne' }))).ok).toBe(true);
    expect(appels).toEqual(['classer']);
  });

  test('prendre en charge (commercial) : le responsable est TOUJOURS l\'acteur ; un résultat par client ; refus détaillés ; plafond', async () => {
    const { p, appels } = depot({ client_attribuer: (pr) => (pr.p_client_id === ID(11) ? { error: 'DEJA_ATTRIBUE' } : { data: { ok: true } }) });
    const r = await traiterAction(p, CLEMENT, form({ operation: 'prendre', client_ids: [ID(10), ID(11), ID(12)], responsable_id: ID(6), nouveau_id: ID(6) }));     // un autre responsable demandé : ignoré
    expect(r.ok).toBe(true); expect(r.message).toBe('2 clients pris en charge — journalisé. 1 refusé : Ce client a déjà un responsable : seul un administrateur peut le transférer.');
    expect(appels.map(a => a.params.p_client_id)).toEqual([ID(10), ID(11), ID(12)]);
    for (const a of appels) expect(a.params).toMatchObject({ p_action: 'prise_en_charge', p_nouveau_id: ID(2), p_nouveau_email: 'clement@inca.re', p_acteur_id: ID(2), p_acteur_role: 'commercial' });
    const tout = depot({ client_attribuer: () => ({ error: 'DEJA_ATTRIBUE' }) });
    expect(await traiterAction(tout.p, CLEMENT, form({ operation: 'prendre', client_ids: [ID(10)] }))).toMatchObject({ ok: false });
    expect((await traiterAction(p, CLEMENT, form({ operation: 'prendre', client_ids: Array.from({ length: MAX_PRISE_EN_CHARGE + 1 }, (_, i) => ID(i + 2000)) }))).message).toMatch(/Pas plus de/);
  });

  test('retirer (administrateur) : motif obligatoire ; classer : valeur contrôlée, « non classé » = remise à zéro, commandes passées inchangées', async () => {
    const a = depot();
    expect((await traiterAction(a.p, ADMIN, form({ operation: 'retirer', client_ids: [ID(10)] }))).message).toMatch(/motif/);
    expect((await traiterAction(a.p, ADMIN, form({ operation: 'retirer', client_ids: [ID(10), ID(11)], motif: 'Départ' }))).message).toBe('2 responsables retirés — journalisé.');
    expect(a.appels.map(x => [x.params.p_action, x.params.p_motif])).toEqual([['retrait', 'Départ'], ['retrait', 'Départ']]);
    const b = depot({ clients_classer_groupe_lot: () => ({ data: { classes: 2, inchanges: 1 } }) });
    expect((await traiterAction(b.p, ADMIN, form({ operation: 'classer', client_ids: [ID(10)], valeur: 'partenaire' }))).message).toBe('Choisissez une classification.');
    const r = await traiterAction(b.p, ADMIN, form({ operation: 'classer', client_ids: [ID(10), ID(11), ID(12)], valeur: 'interne', motif: 'Validé direction' }));
    expect(r.message).toBe('2 clients classés « Groupe Incana » · 1 déjà dans cette classe — journalisé. Les commandes passées ne changent pas.');
    await traiterAction(b.p, ADMIN, form({ operation: 'classer', client_ids: [ID(10)], valeur: 'non_classe' }));
    expect(b.appels.map(x => x.params.p_valeur)).toEqual(['interne', null]);
    expect(b.appels[0].params).toMatchObject({ p_acteur_email: 'admin@inca.re', p_acteur_role: 'admin', p_motif: 'Validé direction' });
  });

  test('FALSIFICATION : des champs d\'identité ou de rôle ajoutés au formulaire sont ignorés ; les erreurs de la base sont traduites sans détail technique', async () => {
    const { p, appels } = depot({ clients_attribuer_lot: () => ({ error: 'ERROR: relation "orders" violates something at db.internal:5432' }) });
    const r = await traiterAction(p, CLEMENT, form({ operation: 'prendre', client_ids: [ID(10)], role: 'admin', acteur: ID(1), acteur_id: ID(1), acteur_email: 'admin@inca.re', p_acteur_role: 'admin' }));
    expect(appels[0].params).toMatchObject({ p_acteur_id: ID(2), p_acteur_email: 'clement@inca.re', p_acteur_role: 'commercial' });
    expect(r.ok).toBe(true);
    const e = await traiterAction(p, ADMIN, form({ operation: 'attribuer', client_ids: [ID(10)], responsable_id: ID(2), motif: 'ok ok' }));
    expect(e).toEqual({ ok: false, message: "L'opération a échoué : rien n'a été modifié." });        // aucun détail interne
  });

  test('STATIQUE composant et page : le commercial ne coche que les clients libres ; chaque fenêtre exige la confirmation ; aucun champ d\'identité ni de rôle ; aucune donnée de coût', async () => {
    const { readFileSync } = await import('node:fs');
    const c = readFileSync('src/components/admin/PortefeuillesListe.astro', 'utf8').replace(/\r\n/g, '\n');
    const p = readFileSync('src/pages/admin/portefeuilles.astro', 'utf8').replace(/\r\n/g, '\n');
    expect(c).toContain('const selectionnable = (l: LigneClient) => admin || l.responsable_id == null;');
    const fenetres = c.match(/<dialog id="pf-dlg-[a-z]+"[\s\S]*?<\/dialog>/g) ?? [];
    expect(fenetres.length).toBe(4);                                                              // attribuer, classer, retirer (admin) + prendre en charge (commercial)
    for (const f of fenetres) { expect(f).toMatch(/name="confirme" value="oui" required/); expect(f).toMatch(/<button type="submit" name="operation"/); expect(f).toMatch(/name="retour"/); }
    expect(c).not.toMatch(/name="(role|acteur|acteur_id|acteur_email|responsable_email|email)"/);
    const code = (c + '\n' + p).split('\n').filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');       // hors commentaires
    expect(code).not.toMatch(/prix_achat|pump|unit_cost|amount_ht|marge|price_ht_snapshot|pump_snapshot/i);
    expect(p).toMatch(/acteurDepuisSession\(\(Astro\.locals as any\)\.user\)/);
    expect(p).toMatch(/if \(!acteur\) return Astro\.redirect\('\/admin'\)/);
    expect(p.indexOf('if (!acteur)')).toBeLessThan(p.indexOf('supabaseAdmin.from'));                // contrôle d'accès avant toute lecture
  });

  test('adresse de retour : uniquement la page Portefeuilles ; filtres conservés ; ancien message remplacé ; texte encodé', () => {
    const ok = { ok: true, message: '3 clients attribués — journalisé.' };
    expect(adresseRetour('/admin/portefeuilles?f=non_attribues&q=caf%C3%A9&ok=ancien', ok)).toBe('/admin/portefeuilles?f=non_attribues&q=caf%C3%A9&ok=3+clients+attribu%C3%A9s+%E2%80%94+journalis%C3%A9.');
    for (const mauvais of ['https://pirate.example/x', '//pirate.example', '/admin/commandes', '/admin/portefeuilles/../clients', 'javascript:alert(1)', null, undefined, 42]) {
      expect(adresseRetour(mauvais, { ok: false, message: 'Non.' }), String(mauvais)).toBe('/admin/portefeuilles?err=Non.');
    }
    expect(adresseRetour('/admin/portefeuilles?err=vieux&f=prospects', { ok: true, message: 'Ok' })).toBe('/admin/portefeuilles?f=prospects&ok=Ok');
  });
});
