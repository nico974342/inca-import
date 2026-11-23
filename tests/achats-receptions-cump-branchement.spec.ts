/**
 * Réceptions de commande × recalcul des marges (CUMP) — câblage de la couche applicative.
 * Après une réception OU une annulation RÉUSSIE, la file CUMP est traitée immédiatement (les demandes sont déposées par la base dans la transaction) ;
 * jamais après un refus ; une panne du traitement ne change JAMAIS le résultat de l'opération ; la correction de quantité commandée n'a aucun effet sur le coût.
 * Aucune base, aucune connexion : dépôt factice.
 */
import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { creerAchats } from '../src/lib/achatsReception';
import type { DepotPortefeuille } from '../src/lib/portefeuille';

const ID = (n: number) => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`;
const ADMIN = { id: ID(1), email: 'admin@inca.re', app_metadata: { role: 'admin' } };
const ok = { cle: ID(10), shipmentId: ID(11), receivedAt: '2026-11-10', lignes: [{ id: ID(12), quantite: '40', cout: '4,5' }] };
const depot = (reponse: { data?: unknown; error?: { message: string } | null }): DepotPortefeuille => ({ async rpc() { return { data: reponse.data ?? { reception_id: ID(9), deja: false }, error: reponse.error ?? null }; }, async trouverCompte() { return null; } });

test.describe('Traitement immédiat de la file CUMP après une écriture réussie', () => {
  test('réception réussie, rejeu et annulation réussie : la file est traitée ; refus de la base, refus de saisie, quantité commandée : jamais', async () => {
    let appels = 0; const a = creerAchats(depot({}), async () => { appels++; });
    expect((await a.enregistrer({ utilisateur: ADMIN as any, ...ok })).ok).toBe(true); expect(appels).toBe(1);
    expect((await a.annuler({ utilisateur: ADMIN as any, receptionId: ID(13), motif: 'Erreur de saisie' })).ok).toBe(true); expect(appels).toBe(2);
    expect((await a.modifierQuantite({ utilisateur: ADMIN as any, ligneId: ID(12), quantite: '12', motif: 'Surplus accepté' })).ok).toBe(true); expect(appels).toBe(2);   // aucun effet sur le coût
    expect((await a.enregistrer({ utilisateur: ADMIN as any, ...ok, receivedAt: 'demain' })).ok).toBe(false); expect(appels).toBe(2);                                      // refus de saisie
    expect((await a.enregistrer({ utilisateur: null as any, ...ok })).ok).toBe(false); expect(appels).toBe(2);                                                              // pas d'identité
    const refusee = creerAchats(depot({ data: null, error: { message: 'DEPASSEMENT_COMMANDE : 31 demandé(s)' } }), async () => { appels++; });
    expect((await refusee.enregistrer({ utilisateur: ADMIN as any, ...ok })).ok).toBe(false);
    expect((await refusee.annuler({ utilisateur: ADMIN as any, receptionId: ID(13), motif: 'Erreur de saisie' })).ok).toBe(false); expect(appels).toBe(2);               // refus de la base : rien à traiter
  });

  test('une panne du traitement des marges ne change pas le résultat de la réception ni de l\'annulation (la demande reste en file, reprise par la tâche quotidienne)', async () => {
    const a = creerAchats(depot({}), async () => { throw new Error('délai dépassé'); });
    const r = await a.enregistrer({ utilisateur: ADMIN as any, ...ok }); expect(r.ok).toBe(true);
    expect((await a.annuler({ utilisateur: ADMIN as any, receptionId: ID(13), motif: 'Erreur de saisie' })).ok).toBe(true);
  });

  test('en production : la version câblée appelle traiterFileCump ; les routes de réception libre de main l\'appellent toujours (création, modification, suppression)', () => {
    const lib = readFileSync('src/lib/achatsReception.ts', 'utf8');
    expect(lib).toContain("export const achats = creerAchats(depotSupabase, () => traiterFileCump(supabaseAdmin as any));");
    expect(lib.indexOf("if (r.ok) await apres();")).toBeGreaterThan(lib.indexOf("appeler('reception_commande_enregistrer'"));
    for (const f of ['src/pages/api/admin/reception/create.ts', 'src/pages/api/admin/reception/[id]/update.ts', 'src/pages/api/admin/reception/[id]/delete.ts']) {
      const s = readFileSync(f, 'utf8'); expect(s, f).toContain('await traiterFileCump(supabaseAdmin);');
      expect(s.indexOf('rpc(\'reception_'), f).toBeLessThan(s.indexOf('await traiterFileCump(supabaseAdmin);'));      // APRÈS l'opération
    }
  });

  test('les trois routes de réception libre gardent le gel ET le refus de stock ; une réception rattachée à une commande renvoie un message clair', () => {
    for (const f of ['src/pages/api/admin/reception/[id]/update.ts', 'src/pages/api/admin/reception/[id]/delete.ts']) {
      const s = readFileSync(f, 'utf8'); expect(s, f).toContain("rpcErr?.code === '42501'"); expect(s, f).toContain('messageRefusStock(rpcErr) ?? messageConflitSimultane(rpcErr) ?? messageReceptionLiee(rpcErr)');
      expect(s.indexOf("rpcErr?.code === '42501'"), f).toBeLessThan(s.indexOf('messageRefusStock(rpcErr)'));
    }
    const c = readFileSync('src/pages/api/admin/reception/create.ts', 'utf8'); expect(c).toContain('receptionLibreAutorisee(await etatTransition())'); expect(c).not.toContain('shipmentWarning');
  });
});
