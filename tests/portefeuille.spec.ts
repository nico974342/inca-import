/**
 * Portefeuilles : l'identité de celui qui agit vient de la SESSION serveur, jamais d'un paramètre. Tests hors ligne (dépendances injectées) :
 * aucune connexion à Supabase, aucune écriture.
 */
import { test, expect } from '@playwright/test';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { acteurDepuisSession, creerPortefeuille, type DepotPortefeuille } from '../src/lib/portefeuille';

const ID = (n: number) => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`;
const ADMIN = { id: ID(1), email: 'admin@inca.re', app_metadata: { role: 'admin' } };
const COMMERCIAL = { id: ID(2), email: 'clement@inca.re', app_metadata: { role: 'commercial' } };
const CLIENT = { id: ID(3), email: 'client@x.fr', app_metadata: { role: 'client' } };
const CLIENT_QUI_SE_DIT_ADMIN = { id: ID(4), email: 'pirate@x.fr', app_metadata: {}, user_metadata: { role: 'admin' } };
const CLIENT_CLE_VIDE = { id: ID(5), email: 'sans-role@x.fr', app_metadata: null };
const CLIENT_CLIENT = ID(30), CIBLE = ID(31);

/** Dépôt factice : enregistre les appels, annuaire connu. */
function depot(erreur: string | null = null) {
  const appels: { nom: string; params: Record<string, any> }[] = [];
  const annuaire: Record<string, any> = {
    [ID(1)]: ADMIN, [ID(2)]: COMMERCIAL, [ID(3)]: CLIENT,          // le compte 3 est un CLIENT : ne peut pas être responsable
    [ID(6)]: { id: ID(6), email: 'arnaud@inca.re', app_metadata: { role: 'admin' } },
  };
  const d: DepotPortefeuille = {
    async rpc(nom, params) { appels.push({ nom, params }); return { data: { ok: true }, error: erreur ? { message: erreur } : null }; },
    async trouverCompte(id) { return annuaire[id] ?? null; },
  };
  return { d, appels };
}

test.describe('Portefeuilles — identité côté serveur', () => {
  test('l\'acteur est déduit de la session : app_metadata seulement ; user_metadata, rôle absent ou client = refusé', () => {
    expect(acteurDepuisSession(ADMIN)).toEqual({ id: ADMIN.id, email: ADMIN.email, role: 'admin' });
    expect(acteurDepuisSession(COMMERCIAL)).toEqual({ id: COMMERCIAL.id, email: COMMERCIAL.email, role: 'commercial' });
    expect(acteurDepuisSession(CLIENT)).toBeNull();
    expect(acteurDepuisSession(CLIENT_QUI_SE_DIT_ADMIN)).toBeNull();        // user_metadata est modifiable par l'utilisateur lui-même : jamais lu
    expect(acteurDepuisSession(CLIENT_CLE_VIDE)).toBeNull();
    expect(acteurDepuisSession(null)).toBeNull(); expect(acteurDepuisSession(undefined)).toBeNull();
    expect(acteurDepuisSession({ ...ADMIN, email: null })).toBeNull(); expect(acteurDepuisSession({ ...ADMIN, id: null })).toBeNull();
    expect(acteurDepuisSession({ id: ID(9), email: 'x@x.fr', app_metadata: { role: 'superadmin' } })).toBeNull();
  });

  test('FALSIFICATION : aucun paramètre ne peut remplacer l\'identité ou le rôle ; la base reçoit TOUJOURS ceux de la session', async () => {
    const { d, appels } = depot(); const p = creerPortefeuille(d);
    // un navigateur malveillant ajoute des champs : ils sont ignorés
    const r = await p.attribuerClient({ utilisateur: COMMERCIAL, clientId: ID(40), action: 'prise_en_charge', nouveauId: ADMIN.id,
      ...({ role: 'admin', acteur: { id: ADMIN.id, email: ADMIN.email, role: 'admin' }, acteurEmail: 'admin@inca.re', p_acteur_role: 'admin' } as any) });
    expect(r.ok).toBe(true);
    expect(appels[0].params).toMatchObject({ p_acteur_id: COMMERCIAL.id, p_acteur_email: COMMERCIAL.email, p_acteur_role: 'commercial', p_nouveau_id: COMMERCIAL.id, p_nouveau_email: COMMERCIAL.email });
    // prise en charge : le responsable est l'acteur, même si on réclame un autre nouveauId
    expect(appels[0].params.p_nouveau_id).not.toBe(ADMIN.id);
  });

  test('le NOUVEAU responsable est retrouvé dans l\'annuaire : personnel uniquement, e-mail relu (pas celui du navigateur) ; sinon refus SANS appel à la base', async () => {
    const { d, appels } = depot(); const p = creerPortefeuille(d);
    const ok = await p.attribuerClient({ utilisateur: ADMIN, clientId: ID(40), action: 'attribution', nouveauId: ID(6), ...({ nouveauEmail: 'faux@pirate.fr' } as any) });
    expect(ok.ok).toBe(true);
    expect(appels[0].params).toMatchObject({ p_nouveau_id: ID(6), p_nouveau_email: 'arnaud@inca.re', p_action: 'attribution' });   // e-mail de l'annuaire
    for (const mauvais of [ID(3), ID(99), 'pas-un-uuid', null, undefined, '', ID(6).toUpperCase().replace(/-/g, '')]) {
      const r = await p.attribuerClient({ utilisateur: ADMIN, clientId: ID(40), action: 'transfert', nouveauId: mauvais as any, motif: 'test' });
      expect(r, String(mauvais)).toEqual({ ok: false, message: 'Responsable invalide.' });
    }
    expect(appels.length).toBe(1);                                              // aucun des refus n'a atteint la base
  });

  test('un compte qui n\'est pas du personnel (client, sans rôle, rôle dans user_metadata) ne déclenche AUCUN appel', async () => {
    const { d, appels } = depot(); const p = creerPortefeuille(d);
    for (const u of [CLIENT, CLIENT_QUI_SE_DIT_ADMIN, CLIENT_CLE_VIDE, null]) {
      for (const action of ['attribution', 'transfert', 'retrait', 'prise_en_charge'] as const) {
        expect((await p.attribuerClient({ utilisateur: u, clientId: ID(40), action, nouveauId: ID(6), motif: 'x' })).ok).toBe(false);
      }
      expect((await p.attribuerClientsEnLot({ utilisateur: u, clientIds: [ID(40)], nouveauId: ID(6), motif: 'x' })).ok).toBe(false);
      expect((await p.classerClient({ utilisateur: u, clientId: ID(40), valeur: 'interne' })).ok).toBe(false);
      expect((await p.classerClientsEnLot({ utilisateur: u, clientIds: [ID(40)], valeur: 'interne' })).ok).toBe(false);
    }
    expect(appels).toEqual([]);
  });

  test('actions réservées à l\'administrateur : un commercial est refusé AVANT la base (lots, classement) ; identifiants invalides refusés', async () => {
    const { d, appels } = depot(); const p = creerPortefeuille(d);
    expect((await p.attribuerClientsEnLot({ utilisateur: COMMERCIAL, clientIds: [ID(40)], nouveauId: ID(6), motif: 'x' })).ok).toBe(false);
    expect((await p.classerClient({ utilisateur: COMMERCIAL, clientId: ID(40), valeur: 'interne' })).ok).toBe(false);
    expect((await p.classerClientsEnLot({ utilisateur: COMMERCIAL, clientIds: [ID(40)], valeur: 'externe' })).ok).toBe(false);
    for (const lot of [[], null, 'a', [ID(40), 'x'], Array.from({ length: 201 }, (_, i) => ID(i + 100))]) {
      expect((await p.attribuerClientsEnLot({ utilisateur: ADMIN, clientIds: lot as any, nouveauId: ID(6), motif: 'x' })).ok, JSON.stringify(lot)?.slice(0, 20)).toBe(false);
    }
    expect((await p.attribuerClient({ utilisateur: ADMIN, clientId: 'pas-un-uuid', action: 'retrait', motif: 'x' })).ok).toBe(false);
    expect((await p.attribuerClient({ utilisateur: ADMIN, clientId: ID(40), action: 'bricoler' as any })).ok).toBe(false);
    expect(appels).toEqual([]);
    // et l'administrateur passe, avec ses propres identifiants
    expect((await p.classerClient({ utilisateur: ADMIN, clientId: ID(40), valeur: 'interne', motif: 'validé' })).ok).toBe(true);
    expect(appels[0]).toEqual({ nom: 'client_classer_groupe', params: { p_client_id: ID(40), p_valeur: 'interne', p_acteur_email: ADMIN.email, p_acteur_role: 'admin', p_motif: 'validé' } });
    expect((await p.attribuerClientsEnLot({ utilisateur: ADMIN, clientIds: [ID(40), ID(41)], nouveauId: ID(6), motif: 'Lot' })).ok).toBe(true);
    expect(appels[1].params).toMatchObject({ p_client_ids: [ID(40), ID(41)], p_nouveau_email: 'arnaud@inca.re', p_acteur_id: ADMIN.id, p_acteur_role: 'admin' });
  });

  test('retrait : pas de nouveau responsable ; erreurs de la base traduites en français sans rien divulguer', async () => {
    const a = depot(); const r = await creerPortefeuille(a.d).attribuerClient({ utilisateur: ADMIN, clientId: ID(40), action: 'retrait', nouveauId: ID(6), motif: 'Départ' });
    expect(r.ok).toBe(true); expect(a.appels[0].params).toMatchObject({ p_nouveau_id: null, p_nouveau_email: null, p_action: 'retrait' });   // un nouveauId éventuel est ignoré
    const b = depot('error: DEJA_ATTRIBUE (détail interne sensible)'); const e = await creerPortefeuille(b.d).attribuerClient({ utilisateur: COMMERCIAL, clientId: ID(40), action: 'prise_en_charge' });
    expect(e).toEqual({ ok: false, message: 'Ce client a déjà un responsable : seul un administrateur peut le transférer.' });
    const c = depot('connection refused to db.internal'); expect(await creerPortefeuille(c.d).attribuerClient({ utilisateur: ADMIN, clientId: ID(40), action: 'retrait', motif: 'x' }))
      .toEqual({ ok: false, message: "L'opération a échoué : rien n'a été modifié." });
  });

  test('GARDE-FOU pour les futures routes : tout fichier qui utilise portefeuille doit lire l\'utilisateur de la session et ne rien prendre du formulaire pour l\'identité', () => {
    const fichiers = (d: string): string[] => readdirSync(d).flatMap(n => { const p = join(d, n); return statSync(p).isDirectory() ? fichiers(p) : /\.(astro|ts)$/.test(n) ? [p] : []; });
    for (const f of fichiers('src/pages')) {
      const s = readFileSync(f, 'utf8');
      if (!/lib\/portefeuille'/.test(s)) continue;
      expect(s, `${f} : doit utiliser l'utilisateur de la session`).toMatch(/locals\.user|locals as any\)\.user|getUser\(\)/);
      expect(s, `${f} : l'identité ne doit pas venir du formulaire`).not.toMatch(/\.get\(\s*['"](role|acteur|acteur_id|acteur_email|acteurEmail|responsable_email|nouveau_email)['"]\s*\)/);
      expect(s, `${f} : le rôle ne doit pas venir du corps de la requête`).not.toMatch(/(body|json|data)\.(role|acteur)/);
    }
    // la bibliothèque elle-même ne lit jamais user_metadata pour décider d'un droit
    expect(readFileSync('src/lib/portefeuille.ts', 'utf8').split('\n').filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n')).not.toMatch(/user_metadata\??\.\s*role/);
  });
});
