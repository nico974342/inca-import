/**
 * Branchement applicatif du recalcul CUMP : le traitement de la file est appelé APRÈS chaque opération concernée, ne lève jamais, ne change jamais le résultat de l'opération,
 * et reste sans effet tant que la migration n'est pas appliquée. Contrôles du comportement (faux clients) et du code des routes. Aucun accès réseau.
 */
import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { traiterFileCump, reprendreEchecsCump, balayerCump, etatFileCump, oublierAbsenceCump, DELAI_MAX_MS } from '../src/lib/cump';

const lire = (f: string) => readFileSync(f, 'utf8').replace(/\r\n/g, '\n');

test.describe('Bibliothèque : ne lève jamais, jamais bloquante', () => {
  test.beforeEach(() => oublierAbsenceCump());

  test('succès : transmet le résultat de la base', async () => {
    const appels: any[] = [];
    const r = await traiterFileCump({ rpc: async (fn, args) => { appels.push([fn, args]); return { data: { traitees: 2 }, error: null }; } }, 10);
    expect(r).toEqual({ ok: true, resultat: { traitees: 2 } }); expect(appels).toEqual([['cump_traiter_file', { p_limite: 10 }]]);
  });

  test('erreur de la base, exception réseau ou délai dépassé : jamais d\'exception, échec signalé (la demande reste en file côté base)', async () => {
    const erreurs: any[] = []; const avant = console.error; console.error = (...a: any[]) => { erreurs.push(a.join(' ')); };
    try {
      expect(await traiterFileCump({ rpc: async () => ({ data: null, error: { message: 'boom' } }) })).toEqual({ ok: false, erreur: 'boom' });
      expect(await traiterFileCump({ rpc: async () => { throw new Error('réseau coupé'); } })).toMatchObject({ ok: false, erreur: 'réseau coupé' });
      const t0 = Date.now(); const lent = await traiterFileCump({ rpc: () => new Promise(() => {}) as any }, 5, 150);                           // ne répond jamais
      expect(lent.ok).toBe(false); expect(lent.erreur).toContain('délai dépassé'); expect(Date.now() - t0).toBeLessThan(1500);
      expect(DELAI_MAX_MS).toBeLessThanOrEqual(10000);                                                                                      // borne réelle : l'opération d'origine n'attend jamais plus
      expect(erreurs.length).toBe(3); expect(erreurs.every(e => e.startsWith('[cump]'))).toBe(true);                                         // jamais perdu silencieusement
      for (const f of [reprendreEchecsCump, balayerCump, etatFileCump]) expect(await f({ rpc: async () => { throw new Error('x'); } })).toMatchObject({ ok: false });
    } finally { console.error = avant; }
  });

  test('migration pas encore appliquée (fonction absente) : sans effet, sans bruit, une seule tentative par minute', async () => {
    let n = 0; const erreurs: any[] = []; const avant = console.error; console.error = (...a: any[]) => { erreurs.push(a); };
    try {
      const client = { rpc: async () => { n++; return { data: null, error: { code: 'PGRST202', message: 'Could not find the function public.cump_traiter_file' } }; } };
      expect(await traiterFileCump(client)).toEqual({ ok: true, absent: true }); expect(await traiterFileCump(client)).toEqual({ ok: true, absent: true }); expect(await etatFileCump(client)).toEqual({ ok: true, absent: true });
      expect(n).toBe(1); expect(erreurs).toHaveLength(0);
    } finally { console.error = avant; }
  });

  test('reprise : reprend puis traite ; un échec de reprise n\'empêche pas d\'être signalé', async () => {
    const ordre: string[] = [];
    const r = await reprendreEchecsCump({ rpc: async (fn) => { ordre.push(fn); return { data: fn === 'cump_reprendre_echecs' ? { reprises: 1, fusionnees: 0 } : { traitees: 1 }, error: null }; } });
    expect(ordre).toEqual(['cump_reprendre_echecs', 'cump_traiter_file']); expect(r).toMatchObject({ ok: true, resultat: { reprise: { reprises: 1 }, traitement: { traitees: 1 } } });
    const b = await balayerCump({ rpc: async (fn) => ({ data: fn === 'cump_detecter_obsoletes' ? 3 : { traitees: 3 }, error: null }) }); expect(b.resultat).toEqual({ redeposees: 3, traitement: { traitees: 3 } });
  });
});

test.describe('Routes : le traitement vient APRÈS l\'opération et ne la conditionne jamais', () => {
  const cas: [string, string][] = [
    ['src/pages/api/admin/reception/create.ts', "action:       'reception.creation'"],
    ['src/pages/api/admin/reception/[id]/update.ts', "action:       'reception.modification'"],
    ['src/pages/api/admin/reception/[id]/delete.ts', "action:       'reception.suppression'"],
    ['src/pages/api/admin/orders/[id]/delete.ts', "action: 'commande.suppression'"],
    ['src/pages/admin/commandes.astro', "action: 'commande.statut'"],
  ];
  for (const [f, journal] of cas) {
    test(`${f} : appelé après l'écriture au journal, avant la réponse, sans condition sur son résultat`, () => {
      const s = lire(f); const j = s.indexOf(journal); const t = s.indexOf('await traiterFileCump(supabaseAdmin);');
      expect(j, 'journal').toBeGreaterThan(-1); expect(t, 'appel').toBeGreaterThan(j);
      expect(s.match(/traiterFileCump\(/g)?.length).toBe(1);                                                                              // une seule fois
      expect(s).not.toMatch(/(if|while)\s*\(\s*!?\s*\(?\s*await traiterFileCump/); expect(s).not.toMatch(/=\s*await traiterFileCump/);          // le résultat n'influence jamais l'opération
      const operation = f.includes('commandes.astro') ? s.indexOf("rpc('order_mark_livree'") : f.includes('orders') ? s.indexOf("from('orders').delete()") : s.indexOf(".rpc('reception_");
      expect(operation).toBeGreaterThan(-1); expect(operation).toBeLessThan(t);                                                          // après l'opération elle-même
    });
  }

  test('commandes.astro : seulement quand une livraison est concernée (livrée, retour arrière, annulation d\'une livrée)', () => {
    const s = lire('src/pages/admin/commandes.astro');
    expect(s).toContain("if (current.status === 'livree' || new_status === 'livree') await traiterFileCump(supabaseAdmin);");
    expect(s.indexOf("await traiterFileCump(supabaseAdmin);")).toBeGreaterThan(s.indexOf("action: 'commande.statut'"));                       // après la trace de livraison (la date de sortie en dépend)
  });

  test('suppression d\'une commande : seulement si elle était livrée', () => {
    expect(lire('src/pages/api/admin/orders/[id]/delete.ts')).toContain('if (wasLivree) await traiterFileCump(supabaseAdmin);');
  });

  test('points d\'entrée de suivi : administrateurs seulement ; la tâche planifiée refuse tout appel sans le secret configuré ; rien n\'est planifié tant qu\'on ne l\'a pas décidé', () => {
    for (const f of ['src/pages/api/admin/cump/etat.ts', 'src/pages/api/admin/cump/reprendre.ts']) { const s = lire(f); expect(s).toContain('isAdmin(user)'); expect(s.indexOf('isAdmin(user)')).toBeLessThan(s.search(/await (etatFileCump|reprendreEchecsCump)\(/)); }
    expect(lire('src/pages/api/admin/cump/etat.ts')).toContain('export const GET'); expect(lire('src/pages/api/admin/cump/etat.ts')).not.toContain('export const POST');
    expect(lire('src/pages/api/admin/cump/reprendre.ts')).toContain('export const POST'); expect(lire('src/pages/api/admin/cump/reprendre.ts')).not.toContain('export const GET');
    const c = lire('src/pages/api/cron/cump.ts'); expect(c).toContain('!secret ||'); expect(c).toContain('Bearer ${secret}'); expect(c).toContain('401');
    expect(c.indexOf('401')).toBeLessThan(c.indexOf('balayerCump(')); expect(c).toContain('export const GET');
    expect(JSON.parse(readFileSync('vercel.json', 'utf8')).crons).toBeUndefined();
  });

  test('aucune route de la page des marges, du tableau de bord ni des clients n\'est basculée : elles lisent toujours pump_snapshot', () => {
    for (const f of ['src/pages/admin/marges.astro', 'src/pages/admin/index.astro', 'src/pages/admin/produits/index.astro', 'src/pages/admin/clients/performances.astro']) {
      const s = lire(f); expect(s, f).not.toMatch(/cump_/); expect(s, f).toContain('pump');
    }
    expect(lire('src/pages/commande.astro')).toContain('pump_snapshot:     p?.prix_achat_moyen_ht ?? null');                                // le coût moyen courant n'est pas basculé non plus
  });
});
