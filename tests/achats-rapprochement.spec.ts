/**
 * Protection de FA/1 dans le nouveau parcours : tant que son cumul n'est pas rapproché, AUCUNE réception de commande n'est acceptée pour elle (jamais de double entrée en stock) ;
 * la protection se lève d'elle-même après la régularisation et se réarme si elle est annulée ; les autres commandes ne sont jamais concernées. Aucune donnée n'est modifiée par la protection.
 * Base locale PGlite pour la preuve de bout en bout ; dépôt factice pour la logique ; aucune connexion distante.
 */
import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import type { PGlite } from '@electric-sql/pglite';
import { creerAchats } from '../src/lib/achatsReception';
import { rapprochementRequis, COMMANDES_A_RAPPROCHER, messageRapprochement } from '../src/lib/achatsRapprochement';
import type { DepotPortefeuille } from '../src/lib/portefeuille';
import { un } from './helpers/achatsBase';
import { baseFA1, SHIP, TRIPLE_CHOC } from './helpers/fa1Base';

const ID = (n: number) => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`;
const ADMIN = { id: ID(1), email: 'admin@inca.re', app_metadata: { role: 'admin' } };
const SCRIPT = readFileSync('supabase/regularisation/achats_fa1_cumul.sql', 'utf8');
const RETOUR = readFileSync('supabase/retours/achats_fa1_cumul_retour.sql', 'utf8');
const lignes = (id: string) => [{ id, quantite: '7', cout: '17' }];

test.describe('Protection de FA/1 : logique', () => {
  test('rapprochementRequis : seulement la commande listée, sans cumul et sans réception ; toute valeur douteuse = protégée ; les autres commandes jamais', () => {
    expect(rapprochementRequis(SHIP, { cumul: 0 }, 0)).toBe(true);
    expect(rapprochementRequis(SHIP, { cumul: 383 }, 0)).toBe(false);                    // régularisée : levée automatique
    expect(rapprochementRequis(SHIP, { cumul: 0 }, 2)).toBe(false);                      // des réceptions rattachées existent : plus de protection
    for (const douteux of [null, undefined, {}, { cumul: 'x' }]) expect(rapprochementRequis(SHIP, douteux as any, 0)).toBe(true);
    expect(rapprochementRequis(SHIP, { cumul: 0 }, undefined)).toBe(true);
    for (const autre of [ID(5), '', null, undefined, 'constructor', '__proto__']) expect(rapprochementRequis(autre, { cumul: 0 }, 0)).toBe(false);
    expect(Object.keys(COMMANDES_A_RAPPROCHER)).toEqual([SHIP]); expect(messageRapprochement('FA/1')).toContain('Nouvelle réception');
  });

  test('creerAchats.enregistrer : FA/1 non rapprochée = refus AVANT toute écriture ; lecture impossible = refus ; régularisée ou autre commande = passe ; l\'autre commande ne déclenche aucune lecture d\'état', async () => {
    const appels: string[] = []; let etat: any = { cumul: 0, receptions: 0 }; let erreurEtat = false;
    const depot: DepotPortefeuille = { async rpc(nom) { appels.push(nom); if (nom === 'shipment_reception_etat') return erreurEtat ? { data: null, error: { message: 'x' } } : { data: etat, error: null }; return { data: { reception_id: ID(9), deja: false }, error: null }; }, async trouverCompte() { return null; } };
    const a = creerAchats(depot, async () => {});
    const base = { utilisateur: ADMIN as any, cle: ID(10), receivedAt: '2026-11-10' };
    let r = await a.enregistrer({ ...base, shipmentId: SHIP, lignes: lignes(ID(12)) });
    expect(r.ok).toBe(false); expect((r as any).message).toContain('rapprochement'); expect(appels).toEqual(['shipment_reception_etat']);        // aucune écriture envoyée
    appels.length = 0; erreurEtat = true; r = await a.enregistrer({ ...base, shipmentId: SHIP, lignes: lignes(ID(12)) });
    expect(r.ok).toBe(false); expect(appels).toEqual(['shipment_reception_etat']);
    appels.length = 0; erreurEtat = false; etat = { cumul: 383, receptions: 0 }; r = await a.enregistrer({ ...base, shipmentId: SHIP, lignes: lignes(ID(12)) });
    expect(r.ok).toBe(true); expect(appels).toEqual(['shipment_reception_etat', 'reception_commande_enregistrer']);
    appels.length = 0; r = await a.enregistrer({ ...base, shipmentId: ID(11), lignes: lignes(ID(12)) });
    expect(r.ok).toBe(true); expect(appels).toEqual(['reception_commande_enregistrer']);                                                         // commande ordinaire : aucune lecture supplémentaire
  });

  test('pages : la page de réception refuse AVANT de traiter le formulaire ; la fiche masque le bouton et explique ; les autres garde-fous restent', () => {
    const rec = readFileSync('src/pages/admin/achats/[id]/reception.astro', 'utf8');
    expect(rec).toContain('rapprochementRequis(id, c.etat, c.receptions.filter(r => !r.annulee_le).length)');
    expect(rec.indexOf('rapprochementRequis(id, c.etat')).toBeLessThan(rec.indexOf("Astro.request.method === 'POST'"));
    expect(rec.indexOf('ecritureAutorisee(transition)')).toBeLessThan(rec.indexOf('rapprochementRequis(id, c.etat'));
    const idx = readFileSync('src/pages/admin/achats/[id]/index.astro', 'utf8');
    expect(idx).toContain('const peutRecevoir = ecritureOk && e.statut !== \'integrale\' && c.status !== \'annule\' && !aRapprocher;');
    expect(idx).toContain('data-testid="rapprochement"');
  });
});

/** Dépôt réel sur la base locale (mêmes fonctions SQL que la production). */
function depotPglite(db: PGlite): DepotPortefeuille {
  const types: Record<string, string> = { p_cle: 'uuid', p_shipment_id: 'uuid', p_received_at: 'date', p_bl: 'text', p_notes: 'text', p_items: 'jsonb', p_acteur_id: 'uuid', p_acteur_email: 'text', p_acteur_role: 'text' };
  return {
    async rpc(fonction, params) {
      const noms = Object.keys(params); const args = noms.map((n, i) => `${n} => $${i + 1}${types[n] ? '::' + types[n] : ''}`).join(', ');
      try { await db.exec('SET ROLE service_role'); const r = await db.query<any>(`SELECT ${fonction}(${args}) AS r`, noms.map(n => (n === 'p_items' ? JSON.stringify(params[n]) : params[n]))); return { data: r.rows[0].r, error: null }; }
      catch (e: any) { return { data: null, error: { message: String(e.message) } }; } finally { await db.exec('RESET ROLE'); }
    },
    async trouverCompte() { return null; },
  };
}

test('DE BOUT EN BOUT sur la base au schéma de production : FA/1 refusée (stock inchangé) → régularisée = acceptée pour les 7 restants seulement → retour arrière = refusée à nouveau', async () => {
  const db = await baseFA1(); const a = creerAchats(depotPglite(db), async () => {});
  const stock = async () => Number((await un(db, `SELECT stock_quantity q FROM products WHERE id=$1`, [TRIPLE_CHOC.produit])).q);
  const recu = (q: number) => a.enregistrer({ utilisateur: ADMIN as any, cle: crypto.randomUUID(), shipmentId: SHIP, receivedAt: new Date().toISOString().slice(0, 10), lignes: [{ id: TRIPLE_CHOC.ligne, quantite: String(q), cout: '17' }] });
  const s0 = await stock();
  const refus = await recu(7); expect(refus.ok).toBe(false); expect((refus as any).message).toContain('rapprochement'); expect(await stock()).toBe(s0);        // aucun stock ajouté
  expect((await un(db, `SELECT count(*)::int n FROM stock_receptions WHERE shipment_id = $1`, [SHIP])).n).toBe(0);
  await db.exec(SCRIPT);                                                                                                                                       // régularisation (383 / 207)
  expect((await recu(8)).ok).toBe(false); expect(await stock()).toBe(s0);                                                                                      // 8 > 7 restants : refusé par la base
  const ok = await recu(7); expect(ok.ok).toBe(true); expect(await stock()).toBe(s0 + 7);                                                                      // exactement le reste
});

test('retour arrière de la régularisation : la protection se réarme d\'elle-même', async () => {
  const db = await baseFA1(); const a = creerAchats(depotPglite(db), async () => {});
  await db.exec(SCRIPT); await db.exec(RETOUR);
  const r = await a.enregistrer({ utilisateur: ADMIN as any, cle: crypto.randomUUID(), shipmentId: SHIP, receivedAt: new Date().toISOString().slice(0, 10), lignes: [{ id: TRIPLE_CHOC.ligne, quantite: '7', cout: '17' }] });
  expect(r.ok).toBe(false); expect((r as any).message).toContain('rapprochement');
});
