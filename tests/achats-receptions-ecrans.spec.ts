/**
 * Suivi des achats — réceptions partielles : bibliothèque, formulaires et écrans, de bout en bout sur les VRAIES fonctions SQL (base locale PGlite).
 * Aucune connexion à Supabase, aucune écriture en production.
 */
import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { baseAchats, commande, exec, produit, un } from './helpers/achatsBase';
import { creerAchats, etatReception, correspondFiltre, messageAchats, parseCout, parseFiltreAchats, parseQuantite, FILTRES_ACHATS, LIBELLE_RECEPTION } from '../src/lib/achatsReception';
import { traiterCorrection, traiterReception } from '../src/lib/achatsActions';
import type { DepotPortefeuille } from '../src/lib/portefeuille';

const ID = (n: number) => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`;
const ADMIN = { id: ID(1), email: 'admin@inca.re', app_metadata: { role: 'admin' } };
const CLEMENT = { id: ID(2), email: 'clement@inca.re', app_metadata: { role: 'commercial' } };
const FAUX_ADMIN = { id: ID(3), email: 'faux@x.fr', app_metadata: {}, user_metadata: { role: 'admin' } };   // rôle écrit par l'utilisateur lui-même : ignoré
const CLIENT = { id: ID(4), email: 'client@x.fr', app_metadata: { role: 'client' } };

class F { constructor(private d: Record<string, unknown | unknown[]>) {} get(n: string) { const v = this.d[n]; return Array.isArray(v) ? v[0] : v; } getAll(n: string) { const v = this.d[n]; return v === undefined ? [] : Array.isArray(v) ? v : [v]; } }
const type = (nom: string) => (nom === 'p_items' ? '::jsonb' : nom === 'p_received_at' ? '::date' : nom === 'p_nouvelle' ? '::int' : nom === 'p_cle' || /_id$/.test(nom) && nom !== 'p_acteur_email' ? '::uuid' : '::text');
function depotPglite(db: PGlite, journal: { nom: string; params: Record<string, unknown> }[] = []): DepotPortefeuille {
  return {
    async rpc(fonction, params) {
      journal.push({ nom: fonction, params });
      const noms = Object.keys(params);
      const args = noms.map((n, i) => `${n} => $${i + 1}${type(n)}`).join(', ');
      const valeurs = noms.map(n => (n === 'p_items' ? JSON.stringify(params[n]) : params[n]));
      try { await db.exec('SET ROLE service_role'); const r = await db.query<any>(`SELECT ${fonction}(${args}) AS r`, valeurs); return { data: r.rows[0].r, error: null }; }
      catch (e: any) { return { data: null, error: { message: String(e.message ?? e) } }; }
      finally { await db.exec('RESET ROLE'); }
    },
    async trouverCompte() { return null; },
  };
}
const aujourdhui = async (db: PGlite) => (await un(db, `SELECT ((now() AT TIME ZONE 'UTC') + interval '4 hours')::date::text d`)).d as string;

// ── Fonctions pures ──────────────────────────────────────────────────────────────────────────────────────────────────────────
test.describe('Réceptions partielles — calcul de l\'état, saisies, messages (fonctions pures)', () => {
  test('états : en attente (rien reçu), partiellement (au moins un produit reçu), intégralement (tout reçu) ; progression en %', () => {
    const l = (quantity: number, received_quantity: number | null) => ({ quantity, received_quantity });
    expect(etatReception([l(100, null)], 'en_transit')).toMatchObject({ statut: 'attente', commande: 100, recu: 0, reste: 100, pourcentage: 0, solde: false, historique: false });
    expect(etatReception([l(100, 40)], 'en_transit')).toMatchObject({ statut: 'partielle', recu: 40, reste: 60, pourcentage: 40 });
    expect(etatReception([l(100, 70)], 'arrive_port')).toMatchObject({ statut: 'partielle', reste: 30, pourcentage: 70 });
    expect(etatReception([l(100, 100)], 'en_transit')).toMatchObject({ statut: 'integrale', reste: 0, pourcentage: 100, solde: true });
    // plusieurs produits : intégrale seulement si TOUTES les lignes sont soldées ; une ligne à zéro laisse la commande partielle
    expect(etatReception([l(100, 100), l(50, 0), l(20, null)], 'en_transit')).toMatchObject({ statut: 'partielle', commande: 170, recu: 100, reste: 70 });
    expect(etatReception([l(100, 100), l(50, 50)], 'en_transit').statut).toBe('integrale');
    expect(etatReception([l(100, 99)], 'en_transit').pourcentage).toBe(99);                         // jamais 100 % tant que tout n'est pas reçu
    expect(etatReception([l(1000, 999)], 'en_transit').pourcentage).toBe(99);
    expect(etatReception([], 'commande')).toMatchObject({ statut: 'attente', lignes: 0, pourcentage: 0, solde: false });
    // le statut logistique n'influence pas la réception (sauf commande clôturée avant le suivi par quantités)
    for (const st of ['commande', 'en_transit', 'arrive_port', 'dedouanement']) expect(etatReception([l(100, 40)], st).statut).toBe('partielle');
    expect(etatReception([l(100, null)], 'receptionne')).toMatchObject({ statut: 'integrale', historique: true, pourcentage: 100, reste: 100 });
    expect(etatReception([l(100, 100)], 'receptionne')).toMatchObject({ statut: 'integrale', historique: false });
    expect(etatReception([l(10, 12)], 'en_transit')).toMatchObject({ solde: true, recu: 10, reste: 0 });   // ancien sur-reçu : plafonné pour l'affichage
    expect(Object.values(LIBELLE_RECEPTION)).toEqual(['En attente de réception', 'Partiellement réceptionnée', 'Réceptionnée intégralement']);
  });

  test('filtre « Reste à recevoir » : jamais les commandes annulées, clôturées ou soldées ; « partielles » = au moins un produit reçu', () => {
    const l = (quantity: number, received_quantity: number | null) => ({ quantity, received_quantity });
    const attente = etatReception([l(10, null)], 'commande'), partielle = etatReception([l(10, 4)], 'en_transit'), integrale = etatReception([l(10, 10)], 'receptionne');
    expect(FILTRES_ACHATS).toEqual(['en_cours', 'reste', 'partielles', 'toutes']);
    expect(correspondFiltre('reste', attente, 'commande')).toBe(true); expect(correspondFiltre('reste', partielle, 'en_transit')).toBe(true);
    expect(correspondFiltre('reste', integrale, 'receptionne')).toBe(false); expect(correspondFiltre('reste', partielle, 'annule')).toBe(false);
    expect(correspondFiltre('partielles', attente, 'commande')).toBe(false); expect(correspondFiltre('partielles', partielle, 'en_transit')).toBe(true);
    expect(correspondFiltre('en_cours', attente, 'commande')).toBe(true); expect(correspondFiltre('en_cours', integrale, 'receptionne')).toBe(false);
    expect(correspondFiltre('toutes', integrale, 'receptionne')).toBe(true); expect(correspondFiltre('toutes', partielle, 'annule')).toBe(true);
    expect(parseFiltreAchats('reste')).toBe('reste'); expect(parseFiltreAchats('piege')).toBe('en_cours'); expect(parseFiltreAchats(null)).toBe('en_cours');
  });

  test('saisies : quantité = entier strict de cartons (vide = 0) ; coût décimal avec virgule ou point ; rien d\'autre', () => {
    for (const [v, a] of [['', 0], ['0', 0], ['40', 40], [' 7 ', 7], [undefined, 0], [null, 0], ['9999999', 9999999]] as const) expect(parseQuantite(v)).toBe(a);
    for (const v of ['1.5', '1,5', '-3', '+4', 'abc', '1e3', '10000000', '٣', '4 0', '0x10']) expect(parseQuantite(v), v).toBeNull();
    expect(parseCout('4,25')).toBe(4.25); expect(parseCout('4.25')).toBe(4.25); expect(parseCout('0')).toBe(0); expect(parseCout(' 12 ')).toBe(12);
    for (const v of ['', '-1', 'abc', '1,2,3', '1e2']) expect(parseCout(v), v).toBeNull();
  });

  test('messages : un code de la base devient une phrase claire ; le détail chiffré est conservé ; un code inconnu ne révèle rien', () => {
    expect(messageAchats('error: DEPASSEMENT_COMMANDE : 30 demandé(s) pour 20 restant(s) à recevoir (commandé 100, déjà reçu 80)')).toContain('20 restant(s)');
    expect(messageAchats('DEPASSEMENT_COMMANDE : 30 demandé(s)')).toContain('un administrateur doit d\'abord modifier la quantité commandée');
    expect(messageAchats('STOCK_DEJA_ENGAGE : Cola — 100 à retirer mais seulement 70 disponible(s)')).toContain('70 disponible(s)');
    expect(messageAchats('COMMANDE_DEJA_SOLDEE')).toContain('entièrement réceptionnée');
    expect(messageAchats('violates foreign key constraint "x"')).toBe("L'opération a échoué : rien n'a été enregistré (ni stock, ni réception).");
    expect(messageAchats(null)).toContain("rien n'a été enregistré");
  });
});

// ── Bibliothèque avec une base factice : ce qui part vers la base ────────────────────────────────────────────────────────
test.describe('Bibliothèque — identité, validations, ce qui est envoyé à la base', () => {
  const enregistre: { nom: string; params: Record<string, unknown> }[] = [];
  const depot: DepotPortefeuille = { async rpc(nom, params) { enregistre.push({ nom, params }); return { data: { reception_id: ID(9), deja: false }, error: null }; }, async trouverCompte() { return null; } };
  const a = creerAchats(depot);
  const ok = { cle: ID(10), shipmentId: ID(11), receivedAt: '2026-11-10', lignes: [{ id: ID(12), quantite: '40', cout: '4,5' }] };

  test('l\'identité vient de la session : seul un administrateur agit ; client, commercial, rôle auto-déclaré ou absence de session : refusés, rien n\'est envoyé', async () => {
    enregistre.length = 0;
    for (const u of [CLEMENT, CLIENT, FAUX_ADMIN, null, undefined]) {
      expect((await a.enregistrer({ utilisateur: u as any, ...ok })).ok).toBe(false);
      expect((await a.annuler({ utilisateur: u as any, receptionId: ID(13), motif: 'Erreur de saisie' })).ok).toBe(false);
      expect((await a.modifierQuantite({ utilisateur: u as any, ligneId: ID(12), quantite: '12', motif: 'Surplus accepté' })).ok).toBe(false);
    }
    expect(enregistre).toEqual([]);
  });

  test('un enregistrement valide envoie UNE seule opération atomique avec l\'identité de la session (jamais celle du formulaire) ; les lignes à 0 ne partent pas', async () => {
    enregistre.length = 0;
    const r = await a.enregistrer({ utilisateur: ADMIN, ...ok, bl: ' BL 12 ', notes: 'Palette  abîmée', lignes: [...ok.lignes, { id: ID(14), quantite: '', cout: '1' }, { id: ID(15), quantite: '0', cout: '' }] });
    expect(r.ok).toBe(true);
    expect(enregistre).toHaveLength(1);
    expect(enregistre[0].nom).toBe('reception_commande_enregistrer');
    expect(enregistre[0].params).toEqual({
      p_cle: ID(10), p_shipment_id: ID(11), p_received_at: '2026-11-10', p_bl: 'BL 12', p_notes: 'Palette abîmée',
      p_items: [{ shipment_item_id: ID(12), quantity: 40, unit_cost_ht: 4.5, dlc: null }],
      p_acteur_id: ADMIN.id, p_acteur_email: 'admin@inca.re', p_acteur_role: 'admin',
    });
  });

  test('validations côté serveur AVANT tout envoi : clé, commande, date, quantités (décimales, négatives, texte), coût manquant, DLC, ligne inconnue, rien à enregistrer', async () => {
    enregistre.length = 0;
    const essais: [string, Partial<typeof ok> & Record<string, unknown>][] = [
      ['Envoi invalide', { cle: 'x' }], ['Commande introuvable', { shipmentId: 'x' }], ['Date de réception invalide', { receivedAt: '10/11/2026' }],
      ['Quantité invalide', { lignes: [{ id: ID(12), quantite: '1,5', cout: '4' }] }], ['Quantité invalide', { lignes: [{ id: ID(12), quantite: '-2', cout: '4' }] }],
      ['Coût unitaire invalide', { lignes: [{ id: ID(12), quantite: '5', cout: '' }] }], ['Coût unitaire invalide', { lignes: [{ id: ID(12), quantite: '5', cout: '-1' }] }],
      ['DLC invalide', { lignes: [{ id: ID(12), quantite: '5', cout: '1', dlc: 'demain' }] }], ['ne fait pas partie de cette commande', { lignes: [{ id: 'pas-un-uuid', quantite: '5', cout: '1' }] }],
      ['au moins une quantité', { lignes: [{ id: ID(12), quantite: '0', cout: '' }, { id: ID(14), quantite: '', cout: '' }] }], ['Aucune ligne', { lignes: [] }],
      ['trop long', { bl: 'x'.repeat(121) }], ['trop long', { notes: 'x'.repeat(501) }],
    ];
    for (const [attendu, surcharge] of essais) { const r = await a.enregistrer({ utilisateur: ADMIN, ...ok, ...surcharge } as any); expect(r.ok, attendu).toBe(false); expect((r as any).message, attendu).toContain(attendu); }
    expect(enregistre).toEqual([]);
  });

  test('annulation et modification de quantité : motif obligatoire, quantité entière ≥ 1, identifiants valides', async () => {
    enregistre.length = 0;
    expect((await a.annuler({ utilisateur: ADMIN, receptionId: ID(13), motif: 'ab' })).ok).toBe(false);
    expect((await a.annuler({ utilisateur: ADMIN, receptionId: 'x', motif: 'Erreur de saisie' })).ok).toBe(false);
    expect((await a.modifierQuantite({ utilisateur: ADMIN, ligneId: ID(12), quantite: '0', motif: 'Surplus accepté' })).ok).toBe(false);
    expect((await a.modifierQuantite({ utilisateur: ADMIN, ligneId: ID(12), quantite: '1,5', motif: 'Surplus accepté' })).ok).toBe(false);
    expect((await a.modifierQuantite({ utilisateur: ADMIN, ligneId: ID(12), quantite: '12', motif: '' })).ok).toBe(false);
    expect(enregistre).toEqual([]);
    expect((await a.annuler({ utilisateur: ADMIN, receptionId: ID(13), motif: 'Saisie sur la mauvaise commande' })).ok).toBe(true);
    expect((await a.modifierQuantite({ utilisateur: ADMIN, ligneId: ID(12), quantite: '110', motif: 'Surplus accepté' })).ok).toBe(true);
    expect(enregistre.map(e => e.nom)).toEqual(['reception_commande_annuler', 'shipment_item_quantite_modifier']);
    expect(enregistre[1].params).toMatchObject({ p_item_id: ID(12), p_nouvelle: 110, p_acteur_role: 'admin' });
  });
});

// ── Miroir : le calcul de l'écran = le calcul de la base ───────────────────────────────────────────────────────────────────
test.describe.serial('Miroir JS / SQL et parcours complets (base locale)', () => {
  let db: PGlite; let SRV: DepotPortefeuille; let achats: ReturnType<typeof creerAchats>; const journal: { nom: string; params: Record<string, unknown> }[] = [];
  test.beforeAll(async () => { db = await baseAchats(); SRV = depotPglite(db, journal); achats = creerAchats(SRV); });
  test.afterAll(async () => { await db.close(); });

  test('l\'état calculé par l\'écran est IDENTIQUE à celui de la base sur de nombreux cas (statuts logistiques, cumuls anciens, surplus historique, ligne à zéro)', async () => {
    const p = await produit(db, 'Miroir', 0);
    const cas: { lignes: [number, number | null][]; statut: string }[] = [];
    for (const statut of ['commande', 'en_transit', 'arrive_port', 'dedouanement', 'receptionne', 'annule'])
      for (const lignes of [[[100, null]], [[100, 0]], [[100, 40]], [[100, 99]], [[100, 100]], [[100, 100], [50, null]], [[100, 100], [50, 50]], [[100, 30], [50, 50]], [[10, 12]], [[5, 5], [5, 4], [5, null]], []] as [number, number | null][][])
        cas.push({ lignes, statut });
    for (const c of cas) {
      const { s } = await commande(db, c.lignes.map(([q, r]) => ({ p, q, recu: r })), { statut: c.statut });
      const sql = (await un(db, `SELECT shipment_reception_etat($1::uuid) e`, [s])).e;
      const js = etatReception(c.lignes.map(([quantity, received_quantity]) => ({ quantity, received_quantity })), c.statut);
      expect({ lignes: sql.lignes, commande: sql.commande, recu: sql.recu, reste: sql.reste, cumul: sql.cumul, solde: sql.solde, statut: sql.statut, historique: sql.historique }, JSON.stringify(c))
        .toEqual({ lignes: js.lignes, commande: js.commande, recu: js.recu, reste: js.reste, cumul: js.cumul, solde: js.solde, statut: js.statut, historique: js.historique });
    }
    expect(cas.length).toBe(66);
  });

  test('parcours de l\'écran : 100 cartons en 3 livraisons (40, 30, 30), formulaire → base ; messages explicites ; double envoi ignoré avec explication', async () => {
    const p = await produit(db, 'Cola 33cl', 10); const c = await commande(db, [{ p, q: 100 }]); const date = await aujourdhui(db);
    const formulaire = (cle: string, q: string, extra: Record<string, unknown> = {}) => new F({ cle, received_at: date, bl_fournisseur: 'BL-1', notes: '', 'ligne_id[]': [c.ids[0]], 'quantity[]': [q], 'unit_cost_ht[]': ['4,5'], 'dlc[]': [''], ...extra });
    const cle1 = crypto.randomUUID();
    expect(await traiterReception(achats, ADMIN, c.s, formulaire(cle1, '40'))).toEqual({ ok: true, deja: false, message: 'Réception enregistrée : stock et cumuls mis à jour.' });
    const doublon = await traiterReception(achats, ADMIN, c.s, formulaire(cle1, '40'));            // double clic / renvoi après coupure réseau
    expect(doublon).toMatchObject({ ok: true, deja: true }); expect(doublon.message).toContain('une seule fois');
    expect((await un(db, `SELECT stock_quantity s FROM products WHERE id = $1`, [p])).s).toBe(50);   // 10 + 40, une seule fois
    expect((await traiterReception(achats, ADMIN, c.s, formulaire(crypto.randomUUID(), '30'))).ok).toBe(true);
    expect((await un(db, `SELECT stock_quantity s FROM products WHERE id = $1`, [p])).s).toBe(80);
    // 30 de plus alors qu'il n'en reste que 30 : refusé ?  → 31 refusé, 30 accepté
    const trop = await traiterReception(achats, ADMIN, c.s, formulaire(crypto.randomUUID(), '31'));
    expect(trop.ok).toBe(false); expect(trop.message).toContain('Quantité supérieure au reste à recevoir'); expect(trop.message).toContain('30 restant(s)');
    expect((await un(db, `SELECT stock_quantity s FROM products WHERE id = $1`, [p])).s).toBe(80);
    expect((await traiterReception(achats, ADMIN, c.s, formulaire(crypto.randomUUID(), '30'))).ok).toBe(true);
    expect((await un(db, `SELECT shipment_reception_etat($1::uuid)->>'statut' s`, [c.s])).s).toBe('integrale');
    expect((await un(db, `SELECT status s FROM shipments WHERE id = $1`, [c.s])).s).toBe('receptionne');
    const encore = await traiterReception(achats, ADMIN, c.s, formulaire(crypto.randomUUID(), '1'));
    expect(encore.ok).toBe(false); expect(encore.message).toContain('entièrement réceptionnée');
    expect((await un(db, `SELECT stock_quantity s FROM products WHERE id = $1`, [p])).s).toBe(110);
  });

  test('formulaire : listes décalées, clé absente, utilisateur non administrateur → refus explicite, rien d\'écrit', async () => {
    const p = await produit(db, 'Form', 0); const c = await commande(db, [{ p, q: 10 }]); const date = await aujourdhui(db);
    const base = { cle: crypto.randomUUID(), received_at: date, bl_fournisseur: '', notes: '', 'ligne_id[]': [c.ids[0]], 'quantity[]': ['5'], 'unit_cost_ht[]': ['1'], 'dlc[]': [''] };
    expect((await traiterReception(achats, ADMIN, c.s, new F({ ...base, 'quantity[]': [] }))).message).toContain('Formulaire incomplet');
    expect((await traiterReception(achats, ADMIN, c.s, new F({ ...base, cle: undefined }))).ok).toBe(false);
    for (const u of [CLEMENT, FAUX_ADMIN, CLIENT]) expect((await traiterReception(achats, u, c.s, new F(base))).ok).toBe(false);
    expect((await un(db, `SELECT stock_quantity s FROM products WHERE id = $1`, [p])).s).toBe(0);
    expect((await un(db, `SELECT count(*)::int n FROM stock_receptions WHERE shipment_id = $1`, [c.s])).n).toBe(0);
  });

  test('corrections par l\'écran : modification justifiée (surplus), annulation confirmée et motivée ; stock engagé → refus expliqué', async () => {
    const p = await produit(db, 'Correction', 0); const c = await commande(db, [{ p, q: 100 }]); const date = await aujourdhui(db);
    const f = (q: string) => new F({ cle: crypto.randomUUID(), received_at: date, bl_fournisseur: 'BL', notes: '', 'ligne_id[]': [c.ids[0]], 'quantity[]': [q], 'unit_cost_ht[]': ['5'], 'dlc[]': [''] });
    expect((await traiterReception(achats, ADMIN, c.s, f('80'))).ok).toBe(true);
    expect((await traiterReception(achats, ADMIN, c.s, f('30'))).ok).toBe(false);
    expect((await traiterCorrection(achats, ADMIN, new F({ operation: 'quantite', ligne_id: c.ids[0], quantite: '110', motif: '' }))).message).toContain('motif');
    expect((await traiterCorrection(achats, ADMIN, new F({ operation: 'quantite', ligne_id: c.ids[0], quantite: '110', motif: 'Surplus accepté par le fournisseur' }))).message).toContain('Quantité commandée modifiée');
    expect((await traiterReception(achats, ADMIN, c.s, f('30'))).ok).toBe(true);
    const rec = (await un(db, `SELECT id FROM stock_receptions WHERE shipment_id = $1 ORDER BY created_at DESC LIMIT 1`, [c.s])).id as string;
    expect((await traiterCorrection(achats, ADMIN, new F({ operation: 'annuler', reception_id: rec, motif: 'Mauvaise commande' }))).message).toContain('Confirmez');       // case de confirmation obligatoire
    await db.query(`UPDATE products SET stock_quantity = 20 WHERE id = $1`, [p]);                                    // 90 cartons déjà sortis : il n'en reste que 20 pour 30 à retirer
    const refus = await traiterCorrection(achats, ADMIN, new F({ operation: 'annuler', reception_id: rec, motif: 'Mauvaise commande', confirme: 'oui' }));
    expect(refus.ok).toBe(false); expect(refus.message).toContain('déjà été vendue, réservée ou déplacée'); expect(refus.message).toContain('20 disponible');
    expect((await un(db, `SELECT stock_quantity s FROM products WHERE id = $1`, [p])).s).toBe(20);                   // refus : rien n'a bougé
    await db.query(`UPDATE products SET stock_quantity = 110 WHERE id = $1`, [p]);
    expect((await traiterCorrection(achats, ADMIN, new F({ operation: 'annuler', reception_id: rec, motif: 'Mauvaise commande', confirme: 'oui' }))).ok).toBe(true);
    expect((await un(db, `SELECT stock_quantity s FROM products WHERE id = $1`, [p])).s).toBe(80);
    expect((await traiterCorrection(achats, ADMIN, new F({ operation: 'inconnue' }))).message).toBe('Opération inconnue.');
    for (const u of [CLEMENT, FAUX_ADMIN, CLIENT]) expect((await traiterCorrection(achats, u, new F({ operation: 'quantite', ligne_id: c.ids[0], quantite: '120', motif: 'Tentative' }))).ok).toBe(false);
  });
});

// ── Écrans et garde-fous (code) ────────────────────────────────────────────────────────────────────────────────────────────
test.describe('Écrans : droits, formulaire, compatibilité, icône', () => {
  const lire = (f: string) => readFileSync(f, 'utf8').replace(/\r\n/g, '\n');
  const sansCommentaires = (s: string) => s.replace(/<!--[\s\S]*?-->/g, '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');

  test('pages de détail et de réception : réservées à l\'administrateur côté serveur, avant tout accès aux données', () => {
    for (const f of ['src/pages/admin/achats/[id]/index.astro', 'src/pages/admin/achats/[id]/reception.astro']) {
      const s = lire(f);
      expect(s, f).toContain("if (!isAdmin(utilisateur)) return Astro.redirect('/admin');");
      expect(s.indexOf('isAdmin(utilisateur)'), f).toBeLessThan(s.indexOf('chargerCommande('));
    }
    // la bibliothèque refuse de toute façon un non-administrateur, même si une page était mal protégée
    expect(lire('src/lib/achatsReception.ts')).toContain("a.role === 'admin'");
  });

  test('formulaire de réception : une clé d\'envoi, une ligne par produit non soldé, quantités laissées à zéro possibles, saisie conservée en cas d\'erreur, envoi verrouillé après le premier appui', () => {
    const s = lire('src/pages/admin/achats/[id]/reception.astro');
    for (const m of ['name="cle"', 'name="ligne_id[]"', 'name="quantity[]"', 'name="unit_cost_ht[]"', 'name="dlc[]"', 'name="received_at"', 'name="bl_fournisseur"', 'name="notes"']) expect(s, m).toContain(m);
    expect(s).toContain('crypto.randomUUID()');                                                           // clé créée à l'affichage
    expect(s).toContain("const k = String(f.get('cle') ?? '')");                                          // même clé après une erreur de validation
    expect(s).toContain('saisie[String(lid)]');                                                           // saisie conservée
    expect(s).toMatch(/bouton\.disabled = true/);                                                         // double clic
    expect(s).toContain('Reste à recevoir'); expect(s).toContain('Déjà reçu'); expect(s).toContain('Commandé'); expect(s).toContain('Reçu cette fois');
    expect(s).toContain('max={aujourdhui}');                                                              // pas de date future
    // les lignes soldées n'ont aucun champ : les listes du formulaire restent alignées
    const soldee = s.slice(s.indexOf('if (l.reste === 0) return ('), s.indexOf('return (\n            <li class="rc-ligne"'));
    expect(soldee).not.toMatch(/<input/);
    expect(s).not.toMatch(/disabled=\{/);
  });

  test('page de détail : commandé / déjà reçu / reste par ligne, deux statuts distincts, progression, historique des réceptions, corrections réservées avec motif', () => {
    const s = lire('src/pages/admin/achats/[id]/index.astro');
    for (const m of ['Commandé', 'Déjà reçu', 'Reste à recevoir', 'data-testid="statut-logistique"', 'data-testid="statut-reception"', 'data-testid="progression"', 'role="progressbar"', 'Enregistrer une réception', 'Réceptions successives', 'Annuler cette réception', 'Modifier la quantité commandée'])
      expect(s, m).toContain(m);
    expect(s).toContain('name="motif"'); expect(s).toContain('name="confirme" value="oui" required');
    expect(s).toContain('reçu{c.avantSuivi > 1');                                                       // ancien cumul expliqué
    expect(s).toContain('r.annulee_le && <span class="ach-badge ach-badge--annulee">Annulée</span>');     // une annulation reste visible
  });

  test('liste des commandes : statut de réception et progression sur chaque commande, filtre « Reste à recevoir », nouveau bouton ; l\'ancien chemin de réception est refermé', () => {
    const s = lire('src/pages/admin/achats.astro');
    expect(s).toContain('data-testid="statut-reception"'); expect(s).toContain('data-testid="progression"'); expect(s).toContain('data-testid="filtres-achats"');
    expect(s).toContain('/reception`} class="btn btn-primary btn-sm"'); expect(s).not.toContain('/admin/reception/new?shipment=');
    expect(s).toContain('COMMANDE_RECUE_NON_SUPPRIMABLE');
    const api = lire('src/pages/api/admin/reception/create.ts');
    expect(api).toContain("if (commandeId) return Response.redirect(");
    expect(sansCommentaires(api)).not.toMatch(/received_quantity|shipment_items|shipmentWarning/);          // plus aucune mise à jour de cumul après coup, hors transaction
    expect(lire('src/pages/admin/reception/new.astro')).toContain("if (shipmentId) return Astro.redirect(`/admin/achats/");
    for (const f of ['src/pages/api/admin/reception/[id]/update.ts', 'src/pages/api/admin/reception/[id]/delete.ts']) expect(lire(f), f).toContain('if (liee?.shipment_id)');
    expect(lire('src/pages/admin/reception/[id]/edit.astro')).toContain('if ((reception as any).shipment_id) return Astro.redirect(');
  });

  test('modification d\'une commande : les lignes d\'une commande déjà reçue ne sont jamais recréées ; le statut « Réceptionné » n\'est pas défait par un enregistrement', () => {
    const s = lire('src/pages/admin/achats/[id]/edit.astro');
    expect(s).toContain("gt('received_quantity', 0)"); expect(s).toContain('const verrouillee =');
    expect(s.indexOf('if (verrouillee) {')).toBeLessThan(s.indexOf(".from('shipment_items')" + '.delete()'));   // le retour anticipé précède la suppression en bloc
    expect(s).toContain("courant?.status === 'receptionne' ? 'receptionne' : status");
    expect(s).toContain('data-testid="lignes-verrouillees"');
  });

  test('icône : « Suivi des achats » utilise Lucide clipboard-list ; l\'ancien bateau du menu a disparu ; la route maritime des expéditions et le logo ne sont pas touchés', () => {
    const l = lire('src/components/admin/AdminLayout.astro');
    const lien = l.slice(l.indexOf('<a href="/admin/achats"'), l.indexOf('Suivi des achats</a>'));
    expect(lien).toContain('data-icone="clipboard-list"');
    expect(lien).toContain('<rect width="8" height="4" x="8" y="2" rx="1" ry="1"/>');
    expect(lien).toContain('M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2');
    expect(lien).not.toContain('M2.5 9.5h11l-1.4 3');                                                      // ancien bateau
    expect(l).not.toContain('M2.5 9.5h11l-1.4 3');
    expect(l.match(/data-icone="clipboard-list"/g)).toHaveLength(1);
    // logo INCA IMPORT inchangé (marque dans le menu et fichiers d'icônes) ; la carte de route garde son bateau, qui représente un vrai transport maritime
    expect(l).toContain('<span class="wm-inca">Inca</span><span class="wm-import">Import</span>');
    expect(lire('src/components/admin/ShipRoute.astro')).toContain('class="boat-svg"');
    // aucune autre icône du site ne représentait ce module avec le bateau
    expect(readFileSync('src/pages/admin/achats.astro', 'utf8')).not.toContain('M2.5 9.5h11l-1.4 3');
  });

  test('aucune écriture de prix, de facture ou de TVA dans le nouveau code ; aucune donnée de coût n\'est exposée à un non-administrateur', () => {
    for (const f of ['src/lib/achatsReception.ts', 'src/lib/achatsActions.ts', 'src/lib/achatsCommande.ts', 'src/pages/admin/achats/[id]/index.astro', 'src/pages/admin/achats/[id]/reception.astro']) {
      const s = sansCommentaires(lire(f));
      expect(s, f).not.toMatch(/\.update\(|\.insert\(|\.delete\(|tva|invoice|facture/i);                  // aucune écriture directe : tout passe par la fonction atomique
    }
  });
});
