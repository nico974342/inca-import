/**
 * Suggestions de l'écran « Aujourd'hui » : règles simples, explicables, séparées des relances programmées (fonctions pures).
 */
import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { calculerSuggestions, dateReunion, joursEntre, type ClientSuggestion, type CommandeSuggestion, type InteractionSuggestion, type Masquage } from '../src/lib/crmSuggestions';

const AUJ = '2026-11-11';
const jourAvant = (n: number) => new Date(Date.parse(`${AUJ}T08:00:00Z`) - n * 86400000).toISOString();
const client = (id: string, status: string, creeIlYa: number, extra: Partial<ClientSuggestion> = {}): ClientSuggestion =>
  ({ id, nom: `Nom ${id}`, societe: `Société ${id}`, email: `${id}@x.fr`, status, created_at: jourAvant(creeIlYa), responsable_id: 'resp', rattachement_groupe: 'externe', ...extra });
const cmd = (clientId: string, ilYa: number, status = 'livree', extra: Partial<CommandeSuggestion> = {}): CommandeSuggestion => ({ client_id: clientId, email: null, created_at: jourAvant(ilYa), status, ...extra });
const echange = (clientId: string, ilYa: number, resultat: string | null = 'echange', extra: Partial<InteractionSuggestion> = {}): InteractionSuggestion => ({ client_id: clientId, occurred_at: jourAvant(ilYa), resultat, annulee_le: null, ...extra });
const calc = (p: { clients: ClientSuggestion[]; commandes?: CommandeSuggestion[]; interactions?: InteractionSuggestion[]; relances?: string[]; masquees?: Masquage[] }) =>
  calculerSuggestions({ clients: p.clients, commandes: p.commandes ?? [], interactions: p.interactions ?? [], clientsAvecRelance: new Set(p.relances ?? []), masquees: p.masquees ?? [], aujourdhui: AUJ });
const ids = (l: { clientId: string }[]) => l.map(x => x.clientId);

test.describe('Suggestions « Aujourd\'hui » (règles)', () => {
  test('dates : le jour de La Réunion (UTC+4) et l\'écart en jours', () => {
    expect(dateReunion('2026-11-10T21:00:00Z')).toBe('2026-11-11');       // 01h à La Réunion, le lendemain
    expect(dateReunion('2026-11-11T19:59:00Z')).toBe('2026-11-11');
    expect(dateReunion('2026-11-11T20:00:00Z')).toBe('2026-11-12');
    expect(joursEntre('2026-11-01', '2026-11-11')).toBe(10);
  });

  test('comptes en attente : tri du plus ancien au plus récent, avec le motif', () => {
    const s = calc({ clients: [client('a', 'en_attente', 10), client('b', 'en_attente', 74), client('c', 'actif', 100)] });
    expect(ids(s.compte_en_attente)).toEqual(['b', 'a']);
    expect(s.compte_en_attente[0].pourquoi).toBe("Compte en attente d'activation depuis 74 jours.");
    expect(calc({ clients: [client('a', 'en_attente', 1)] }).compte_en_attente[0].pourquoi).toBe("Compte en attente d'activation depuis 1 jour.");
  });

  test('clients actifs sans commande : une commande annulée ne compte pas ; une commande réelle les retire ; rattachement par e-mail à défaut de client_id', () => {
    const clients = [client('a', 'actif', 30), client('b', 'actif', 30), client('c', 'actif', 30), client('d', 'actif', 30), client('p', 'prospect', 30)];
    const s = calc({ clients, commandes: [cmd('b', 5), cmd('c', 5, 'annulee'), cmd('', 3, 'livree', { client_id: null, email: ' D@X.fr ' })] });
    expect(ids(s.actif_sans_commande).sort()).toEqual(['a', 'c']);
    expect(s.actif_sans_commande[0].pourquoi).toContain('aucune commande');
  });

  test('prospects sans suivi : jamais contacté, ou plus de 30 jours ; pas si un échange récent ou une relance est prévue ; une activité annulée ne compte pas', () => {
    const clients = ['jamais', 'ancien', 'recent', 'prevu', 'annule'].map(id => client(id, 'prospect', 90));
    const s = calc({
      clients, relances: ['prevu'],
      interactions: [echange('ancien', 45), echange('recent', 5), echange('annule', 2, 'echange', { annulee_le: jourAvant(1) }), echange('prevu', 60)],
    });
    expect(ids(s.prospect_sans_suivi)).toEqual(['annule', 'jamais', 'ancien']);      // les jamais contactés d'abord (puis ordre alphabétique), le plus ancien suivi ensuite
    expect(s.prospect_sans_suivi[1].pourquoi).toBe('Prospect jamais contacté, aucune relance prévue.');
    expect(s.prospect_sans_suivi[2].pourquoi).toBe('Aucun échange depuis 45 jours, aucune relance prévue.');
  });

  test('réassort : seulement si le rythme est fiable (3 commandes au moins) et que le retard est net', () => {
    const regulier = (id: string, derniereIlYa: number, nb = 4) => Array.from({ length: nb }, (_, i) => cmd(id, derniereIlYa + (nb - 1 - i) * 30));
    const clients = ['peu', 'ok', 'retard', 'justeapres', 'prospect'].map(id => client(id, id === 'prospect' ? 'prospect' : 'actif', 400));
    const s = calc({ clients, commandes: [...regulier('peu', 90, 2), ...regulier('ok', 10), ...regulier('retard', 80), ...regulier('justeapres', 40), ...regulier('prospect', 90)] });
    expect(ids(s.reassort)).toEqual(['retard']);                          // 2 commandes seulement : jamais de réassort ; 40 j pour un rythme de 30 j : pas encore ; prospect exclu
    expect(s.reassort[0].pourquoi).toBe('Commande habituelle environ tous les 30 jours (sur 4 commandes) ; la dernière date de 80 jours.');
    // les commandes annulées ne comptent pas dans le rythme
    const s2 = calc({ clients: [client('x', 'actif', 400)], commandes: [cmd('x', 100), cmd('x', 70, 'annulee'), cmd('x', 60, 'annulee'), cmd('x', 30)] });
    expect(s2.reassort).toEqual([]);                                      // 2 commandes réelles : rythme non fiable
  });

  test('opportunités : « commande envisagée » ou « rendez-vous pris » sans commande depuis ; une commande passée ensuite les retire ; au-delà de 30 jours elles disparaissent', () => {
    const clients = ['envisagee', 'rdv', 'commande', 'vieux', 'autre'].map(id => client(id, 'actif', 200));
    const s = calc({
      clients, commandes: [cmd('commande', 2)],
      interactions: [echange('envisagee', 5, 'commande_envisagee'), echange('rdv', 8, 'rdv_pris'), echange('commande', 6, 'commande_envisagee'), echange('vieux', 45, 'commande_envisagee'), echange('autre', 3, 'echange')],
    });
    expect(ids(s.opportunite)).toEqual(['envisagee', 'rdv']);
    expect(s.opportunite[0].pourquoi).toBe('Commande envisagée il y a 5 jours, aucune commande passée depuis.');
    expect(s.opportunite[1].pourquoi).toContain('Rendez-vous pris il y a 8 jours');
  });

  test('« commande envisagée » n\'est jamais comptée comme une commande : le client reste « sans commande »', () => {
    const s = calc({ clients: [client('a', 'actif', 30)], interactions: [echange('a', 2, 'commande_envisagee')] });
    expect(ids(s.actif_sans_commande)).toEqual(['a']);
    expect(ids(s.opportunite)).toEqual(['a']);
  });

  test('ignorer ou reporter : masque seulement la règle visée, pour la date choisie, et plus après', () => {
    const clients = [client('a', 'en_attente', 30), client('b', 'en_attente', 30)];
    const masquees: Masquage[] = [{ client_id: 'a', regle: 'compte_en_attente', jusqu_au: '2026-11-18' }, { client_id: 'b', regle: 'reassort', jusqu_au: '2026-11-18' }];
    expect(ids(calc({ clients, masquees }).compte_en_attente)).toEqual(['b']);
    expect(ids(calc({ clients, masquees: [{ client_id: 'a', regle: 'compte_en_attente', jusqu_au: AUJ }] }).compte_en_attente).sort()).toEqual(['a', 'b']);   // échue : revient
  });

  test('chaque suggestion indique le client, son groupe et un motif lisible ; priorité décroissante puis ordre alphabétique', () => {
    const s = calc({ clients: [client('z', 'en_attente', 20, { societe: 'Zèbre', rattachement_groupe: 'interne' }), client('a', 'en_attente', 20, { societe: 'Abricot' })] });
    expect(s.compte_en_attente.map(x => x.libelle)).toEqual(['Abricot', 'Zèbre']);
    expect(s.compte_en_attente[1]).toMatchObject({ groupe: 'interne', regle: 'compte_en_attente' });
    for (const l of Object.values(s)) for (const x of l) expect(x.pourquoi.length).toBeGreaterThan(10);
    expect(calc({ clients: [] })).toEqual({ compte_en_attente: [], actif_sans_commande: [], prospect_sans_suivi: [], reassort: [], opportunite: [] });
  });

  test('séparation : les suggestions n\'écrivent rien et ne touchent à aucune relance ; l\'écran les distingue des tâches', () => {
    const src = readFileSync('src/lib/crmSuggestions.ts', 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    expect(src).not.toMatch(/supabase|weekly_tasks|rpc\(|insert|update\(|delete/i);
    const page = readFileSync('src/pages/admin/aujourdhui.astro', 'utf8');
    expect(page).toContain('data-testid="separation-suggestions"');
    expect(page).toMatch(/ce ne sont pas des tâches/);
    // ordre des sections demandé : relances en retard/du jour, rendez-vous, puis comptes en attente, actifs sans commande, prospects, réassort, opportunités
    const gabarit = ['data-testid="section-retard"', 'data-testid="section-rdv"', 'data-testid="separation-suggestions"', 'data-testid={`section-${s.regle}`}'].map(m => page.indexOf(m));
    expect(gabarit.every(i => i > 0)).toBe(true); expect([...gabarit].sort((x, y) => x - y)).toEqual(gabarit);
    const regles = ["regle: 'compte_en_attente'", "regle: 'actif_sans_commande'", "regle: 'prospect_sans_suivi'", "regle: 'reassort'", "regle: 'opportunite'"].map(m => page.indexOf(m));
    expect(regles.every(i => i > 0)).toBe(true); expect([...regles].sort((x, y) => x - y)).toEqual(regles);
  });

  test('la page « Aujourd\'hui » ne lit ni coût, ni marge, ni prix d\'achat', () => {
    for (const f of ['src/pages/admin/aujourdhui.astro', 'src/pages/admin/activites.astro', 'src/components/admin/CrmFiche.astro', 'src/components/admin/NoterFormulaire.astro', 'src/lib/crm.ts', 'src/lib/crmSuggestions.ts', 'src/lib/crmVue.ts']) {
      // sans les blocs de style (le mot « margin » du CSS n'est pas une donnée), les commentaires et les URL
      const s = readFileSync(f, 'utf8').replace(/<style[\s\S]*?<\/style>/g, '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
      expect(s, f).not.toMatch(/prix_achat|pump|unit_cost|\bmarges?\b|margin_|frais_import|amount_ht|shipment|tva_rate_snapshot/i);
    }
  });
});
