/**
 * Panier et commande client : un produit épuisé ou une quantité insuffisante ne fait JAMAIS perdre le panier.
 * Les actions serveur (src/lib/commandeActions.ts) sont jouées sur une base locale (PGlite) qui embarque les VRAIES fonctions SQL de la production
 * (création contrôlée avec verrous, disponibilité physique − réservé, produits masqués) et la migration d'idempotence. Aucune connexion à Supabase.
 */
import { test, expect } from '@playwright/test';
import type { PGlite } from '@electric-sql/pglite';
import { basePanier, nouveauClient, produitStock, remplirPanier, panierDe, commandesDe, lignesCommande, disponible, depotPglite, createurPglite, createurIndisponible, type Client } from './helpers/panierBase';
import { exec } from './helpers/panierBaseCommun';
import { etatPanier, retirerLigne, reduireLigne, apercuAjustement, confirmerAjustement, traiterEnvoi, panierDejaCommande, type CreateurCommande } from '../src/lib/commandeActions';

let db: PGlite; let n = 0;
test.beforeAll(async () => { db = await basePanier(true); });
test.afterAll(async () => { await db.close(); });
const neuf = async () => { const c = await nouveauClient(db, ++n); return { c, depot: depotPglite(db, c) }; };
const cle = () => crypto.randomUUID();
const total = (p: Record<string, number>) => Object.values(p).reduce((s, q) => s + q, 0);

test.describe('Produit(s) indisponible(s) : le panier est conservé et ajustable', () => {
  test('un produit épuisé : refus clair, panier intact, retrait explicite de CE produit seulement, puis commande des autres', async () => {
    const { c, depot } = await neuf();
    const A = await produitStock(db, 'Cola', 10), B = await produitStock(db, 'Chips épuisées', 0), C = await produitStock(db, 'Eau', 5);
    await remplirPanier(db, c, [[A, 2], [B, 3], [C, 1]]);
    const avant = await panierDe(db, c);

    const etat = await etatPanier(depot, c.id);
    expect(etat.evaluations.map(e => e.statut)).toEqual(['ok', 'epuise', 'ok']);
    expect(etat.plan.map(p => `${p.action}:${p.nom}`)).toEqual(['retirer:Chips épuisées']);

    const r = await traiterEnvoi({ depot, userId: c.id, cle: cle(), createur: createurPglite(db, c) });
    expect(r.type).toBe('conflits');
    if (r.type === 'conflits') expect(r.conflits).toEqual([{ product_id: B, product_name: 'Chips épuisées', requested: 3, available: 0 }]);   // le produit concerné, la quantité demandée et la disponible
    expect(await panierDe(db, c)).toEqual(avant);                                                         // panier INTACT après le refus
    expect(await commandesDe(db, c)).toHaveLength(0);

    expect((await retirerLigne(depot, c.id, B)).ok).toBe(true);
    expect(await panierDe(db, c)).toEqual({ [A]: 2, [C]: 1 });                                            // les autres lignes et leurs quantités sont préservées
    const ok = await traiterEnvoi({ depot, userId: c.id, cle: cle(), createur: createurPglite(db, c) });
    expect(ok.type).toBe('cree');
    expect(await panierDe(db, c)).toEqual({});                                                            // vidé seulement après la création confirmée
    const [cmd] = await commandesDe(db, c); expect(await lignesCommande(db, cmd.id)).toEqual([{ product_id: A, quantity: 2 }, { product_id: C, quantity: 1 }].sort((x, y) => x.product_id.localeCompare(y.product_id)));
    expect(await disponible(db, A)).toBe(8);
  });

  test("plusieurs produits épuisés : tous identifiés ; « Continuer avec les produits disponibles » = aperçu d\'abord, puis confirmation ; les autres lignes ne bougent pas", async () => {
    const { c, depot } = await neuf();
    const ok1 = await produitStock(db, 'Jus A', 20), ok2 = await produitStock(db, 'Jus B', 20);
    const r1 = await produitStock(db, 'Rupture 1', 0), r2 = await produitStock(db, 'Rupture 2', 0), r3 = await produitStock(db, 'Rupture 3', 0);
    await remplirPanier(db, c, [[ok1, 4], [r1, 2], [ok2, 7], [r2, 1], [r3, 9]]);
    const r = await traiterEnvoi({ depot, userId: c.id, cle: cle(), createur: createurPglite(db, c) });
    expect(r.type === 'conflits' && r.conflits.map(x => x.product_name).sort()).toEqual(['Rupture 1', 'Rupture 2', 'Rupture 3']);

    const ap = await apercuAjustement(depot, c.id);                                                       // 1. aperçu : AUCUNE écriture
    expect(ap.lignes).toHaveLength(3); expect(ap.resume).toBe('3 produits retirés');
    expect(await panierDe(db, c)).toEqual({ [ok1]: 4, [r1]: 2, [ok2]: 7, [r2]: 1, [r3]: 9 });
    const conf = await confirmerAjustement(depot, c.id, ap.etat.signature);                               // 2. confirmation du plan affiché
    expect(conf.type).toBe('applique');
    expect(await panierDe(db, c)).toEqual({ [ok1]: 4, [ok2]: 7 });
    expect((await traiterEnvoi({ depot, userId: c.id, cle: cle(), createur: createurPglite(db, c) })).type).toBe('cree');
  });

  test('quantité demandée supérieure au stock : message avec demandé / disponible ; réduction explicite au disponible, calculée par le serveur', async () => {
    const { c, depot } = await neuf();
    const A = await produitStock(db, 'Coca 33cl', 4), B = await produitStock(db, 'Eau 1L', 50);
    await remplirPanier(db, c, [[A, 10], [B, 6]]);
    const e = (await etatPanier(depot, c.id)).evaluations[0];
    expect(e).toMatchObject({ statut: 'reduire', demande: 10, disponible: 4, cible: 4 });
    const r = await traiterEnvoi({ depot, userId: c.id, cle: cle(), createur: createurPglite(db, c) });
    expect(r.type === 'conflits' && r.conflits[0]).toMatchObject({ requested: 10, available: 4 });
    expect((await reduireLigne(depot, c.id, A)).message).toContain('de 10 à 4');
    expect(await panierDe(db, c)).toEqual({ [A]: 4, [B]: 6 });                                            // B inchangé
    expect((await traiterEnvoi({ depot, userId: c.id, cle: cle(), createur: createurPglite(db, c) })).type).toBe('cree');
    expect(await disponible(db, A)).toBe(0);                                                              // jamais plus que le stock
  });

  test('25 références dont UNE seule indisponible : les 24 autres lignes restent exactement les mêmes, une seule action pour continuer', async () => {
    const { c, depot } = await neuf();
    const ids: string[] = []; for (let i = 0; i < 25; i++) ids.push(await produitStock(db, `Référence ${String(i).padStart(2, '0')}`, i === 13 ? 0 : 60, 5 + i));
    const lignes: [string, number][] = ids.map((p, i) => [p, (i % 7) + 1]); await remplirPanier(db, c, lignes);
    const avant = await panierDe(db, c); expect(Object.keys(avant)).toHaveLength(25);
    const r = await traiterEnvoi({ depot, userId: c.id, cle: cle(), createur: createurPglite(db, c) });
    expect(r.type === 'conflits' && r.conflits.map(x => x.product_id)).toEqual([ids[13]]);              // le message ne désigne QUE la référence concernée
    expect(await panierDe(db, c)).toEqual(avant);
    const ap = await apercuAjustement(depot, c.id); expect(ap.etat.plan).toHaveLength(1); expect(ap.resume).toBe('1 produit retiré');
    await confirmerAjustement(depot, c.id, ap.etat.signature);
    const reste = { ...avant }; delete reste[ids[13]];
    expect(await panierDe(db, c)).toEqual(reste);                                                         // 24 lignes, mêmes quantités
    const ok = await traiterEnvoi({ depot, userId: c.id, cle: cle(), createur: createurPglite(db, c) });
    expect(ok.type).toBe('cree'); const [cmd] = await commandesDe(db, c);
    const lc = await lignesCommande(db, cmd.id); expect(lc).toHaveLength(24);
    for (const l of lc) expect(l.quantity).toBe(reste[l.product_id]);
    for (const p of ids.filter(p => p !== ids[13])) expect(await disponible(db, p)).toBe(60 - reste[p]);   // chaque produit réservé pour la quantité exacte
  });

  test("rupture ENTRE l\'affichage du panier et la validation : le contrôle final de la base refuse, le panier reste, la page recalcule et propose l\'ajustement", async () => {
    const { c, depot } = await neuf(); const autre = await neuf();
    const A = await produitStock(db, 'Fanta', 10), B = await produitStock(db, 'Sprite', 10);
    await remplirPanier(db, c, [[A, 6], [B, 3]]);
    expect((await etatPanier(depot, c.id)).plan).toHaveLength(0);                                         // à l'affichage, tout est disponible
    await remplirPanier(db, autre.c, [[A, 8]]);                                                           // pendant ce temps, un autre client réserve 8 sur 10
    expect((await traiterEnvoi({ depot: autre.depot, userId: autre.c.id, cle: cle(), createur: createurPglite(db, autre.c) })).type).toBe('cree');
    const r = await traiterEnvoi({ depot, userId: c.id, cle: cle(), createur: createurPglite(db, c) });
    expect(r.type === 'conflits' && r.conflits).toEqual([{ product_id: A, product_name: 'Fanta', requested: 6, available: 2 }]);
    expect(await panierDe(db, c)).toEqual({ [A]: 6, [B]: 3 });
    const e = (await etatPanier(depot, c.id)).evaluations; expect(e[0]).toMatchObject({ statut: 'reduire', disponible: 2 }); expect(e[1].statut).toBe('ok');
  });

  test("la disponibilité change ENCORE entre l\'aperçu et la confirmation : rien n\'est appliqué, l\'aperçu est remontré (jamais d\'ajustement silencieux)", async () => {
    const { c, depot } = await neuf(); const autre = await neuf();
    const A = await produitStock(db, 'Produit A', 0), B = await produitStock(db, 'Produit B', 10);
    await remplirPanier(db, c, [[A, 2], [B, 5]]);
    const ap = await apercuAjustement(depot, c.id); expect(ap.etat.plan).toHaveLength(1);
    await remplirPanier(db, autre.c, [[B, 9]]); await traiterEnvoi({ depot: autre.depot, userId: autre.c.id, cle: cle(), createur: createurPglite(db, autre.c) });   // B tombe à 1
    const avant = await panierDe(db, c);
    const r = await confirmerAjustement(depot, c.id, ap.etat.signature);
    expect(r.type).toBe('a_revoir'); expect(r.type === 'a_revoir' && r.apercu.lignes).toHaveLength(2);     // le nouvel aperçu montre les DEUX changements
    expect(await panierDe(db, c)).toEqual(avant);                                                         // rien appliqué
    expect((await confirmerAjustement(depot, c.id, 'signature-inventée')).type).toBe('a_revoir');
    expect(await panierDe(db, c)).toEqual(avant);
  });

  test("sans stock disponible d\'un seul produit : le client ne peut pas « réduire » à zéro silencieusement ; retirer reste une action explicite", async () => {
    const { c, depot } = await neuf();
    const A = await produitStock(db, 'Épuisé', 0), B = await produitStock(db, 'Dispo', 5);
    await remplirPanier(db, c, [[A, 3], [B, 1]]);
    const r = await reduireLigne(depot, c.id, A);
    expect(r.ok).toBe(false); expect(r.message).toContain('retirez ce produit');
    expect(await panierDe(db, c)).toEqual({ [A]: 3, [B]: 1 });
    expect((await retirerLigne(depot, c.id, '00000000-0000-4000-8000-000000000000')).ok).toBe(false);
    await db.query(`UPDATE products SET stock_quantity = 3 WHERE id = $1`, [A]);                          // le stock revient entre-temps
    expect((await reduireLigne(depot, c.id, A)).message).toContain('de nouveau disponible');
    expect(await panierDe(db, c)).toEqual({ [A]: 3, [B]: 1 });                                            // rien changé
  });
});

test.describe('Doubles clics, erreurs réseau, panier conservé', () => {
  test("double clic : la MÊME clé ne crée qu\'une commande (envois simultanés, puis renvoi)", async () => {
    const { c, depot } = await neuf(); const A = await produitStock(db, 'Lait', 20);
    await remplirPanier(db, c, [[A, 5]]);
    const k = cle(); const createur = createurPglite(db, c);
    const [r1, r2] = await Promise.all([traiterEnvoi({ depot, userId: c.id, cle: k, createur }), traiterEnvoi({ depot, userId: c.id, cle: k, createur })]);
    expect([r1.type, r2.type].some(t => t === 'cree')).toBe(true);
    expect((await commandesDe(db, c))).toHaveLength(1);
    expect((await traiterEnvoi({ depot, userId: c.id, cle: k, createur })).type).toBe('deja_enregistree');   // un troisième clic tardif
    expect(await disponible(db, A)).toBe(15);                                                             // 5 réservés UNE seule fois
    // la fonction SQL elle-même : même clé, même client = même commande, sans doublon, même si le panier a été rempli à nouveau
    await remplirPanier(db, c, [[A, 5]]);
    const direct = await createur.creer(k, await depot.lireLignes(c.id));
    expect(direct).toMatchObject({ ok: true, deja: true }); expect(await commandesDe(db, c)).toHaveLength(1);
  });

  test('erreur réseau APRÈS la création (réponse perdue) : le panier reste, le nouvel essai ne crée PAS de seconde commande', async () => {
    {
      const { c, depot } = await neuf(); const A = await produitStock(db, 'Thé', 20);
      await remplirPanier(db, c, [[A, 4]]);
      const vrai = createurPglite(db, c);
      const coupe: CreateurCommande = { async creer(k, l) { await vrai.creer(k, l); throw new Error('réseau coupé avant la réponse'); } };
      const k = cle();
      const r1 = await traiterEnvoi({ depot, userId: c.id, cle: k, createur: coupe });
      expect(r1).toEqual({ type: 'erreur', code: 'creation' });
      expect(await panierDe(db, c)).toEqual({ [A]: 4 });                                                  // le panier n'a PAS été vidé : on ne sait pas encore
      expect(await commandesDe(db, c)).toHaveLength(1);                                                   // mais la commande existe
      const r2 = await traiterEnvoi({ depot, userId: c.id, cle: k, createur: vrai });                     // l'utilisateur renvoie
      expect(['cree', 'deja_enregistree']).toContain(r2.type);
      expect(await commandesDe(db, c)).toHaveLength(1);                                                   // toujours UNE seule commande
      expect(await disponible(db, A)).toBe(16);
    }
  });

  test("erreur AVANT la création (réseau, base) : aucune commande, panier conservé à l\'identique, nouvel essai possible", async () => {
    const { c, depot } = await neuf(); const A = await produitStock(db, 'Sirop', 9), B = await produitStock(db, 'Miel', 9);
    await remplirPanier(db, c, [[A, 2], [B, 3]]); const avant = await panierDe(db, c);
    const panne: CreateurCommande = { async creer() { throw new Error('connexion perdue'); } };
    expect((await traiterEnvoi({ depot, userId: c.id, cle: cle(), createur: panne })).type).toBe('erreur');
    expect((await traiterEnvoi({ depot, userId: c.id, cle: cle(), createur: { creer: async () => ({ ok: false as const, error: 'COMPTE_NON_ACTIF' }) } }))).toEqual({ type: 'erreur', code: 'COMPTE_NON_ACTIF' });
    expect(await panierDe(db, c)).toEqual(avant); expect(await commandesDe(db, c)).toHaveLength(0);
    expect((await traiterEnvoi({ depot, userId: c.id, cle: cle(), createur: createurPglite(db, c) })).type).toBe('cree');
  });

  test('panier conservé après un refus de commande, un rechargement de page et plusieurs refus successifs', async () => {
    const { c, depot } = await neuf(); const A = await produitStock(db, 'Boisson', 3), B = await produitStock(db, 'Snack', 40);
    await remplirPanier(db, c, [[A, 9], [B, 12]]); const avant = await panierDe(db, c);
    for (let i = 0; i < 3; i++) {
      expect((await traiterEnvoi({ depot, userId: c.id, cle: cle(), createur: createurPglite(db, c) })).type).toBe('conflits');
      expect(await panierDe(db, c)).toEqual(avant);                                                       // chaque affichage relit le panier enregistré : identique
      expect((await etatPanier(depot, c.id)).lignes.map(l => l.quantity)).toEqual([9, 12]);
    }
    expect(await commandesDe(db, c)).toHaveLength(0);
  });

  test("le panier n\'est vidé qu\'après une création CONFIRMÉE ; si le vidage échoue, la commande existe et le panier identique n\'est PAS recommandé", async () => {
    const { c } = await neuf(); const A = await produitStock(db, 'Café', 30);
    const depot = depotPglite(db, c, { viderEchoue: true });
    await remplirPanier(db, c, [[A, 6]]);
    const r = await traiterEnvoi({ depot, userId: c.id, cle: cle(), createur: createurPglite(db, c) });
    expect(r.type === 'cree' && r.panierVide).toBe(false);                                                // dit clairement que le panier n'a pas pu être vidé
    expect(await commandesDe(db, c)).toHaveLength(1);
    const derniere = await depot.derniereCommande(c.id);
    expect(panierDejaCommande(await depot.lireLignes(c.id), derniere)).toBe(true);                        // la page le signale (« ne la renvoyez pas »)
    expect((await traiterEnvoi({ depot, userId: c.id, cle: cle(), createur: createurPglite(db, c) })).type).toBe('deja_enregistree');   // même sans migration : pas de doublon
    expect(await commandesDe(db, c)).toHaveLength(1);
  });

  test("panier vide à l\'envoi : si une commande vient d\'être enregistrée on le dit (au lieu de renvoyer au catalogue) ; sinon retour au catalogue", async () => {
    const { c, depot } = await neuf(); const A = await produitStock(db, 'Barre', 10);
    expect((await traiterEnvoi({ depot, userId: c.id, cle: cle(), createur: createurPglite(db, c) })).type).toBe('panier_vide');
    await remplirPanier(db, c, [[A, 1]]);
    const r = await traiterEnvoi({ depot, userId: c.id, cle: cle(), createur: createurPglite(db, c) }); expect(r.type).toBe('cree');
    const suite = await traiterEnvoi({ depot, userId: c.id, cle: cle(), createur: createurPglite(db, c) });
    expect(suite.type).toBe('deja_enregistree'); expect(suite.type === 'deja_enregistree' && suite.orderId).toBe(r.type === 'cree' ? r.orderId : '');
  });
});

test.describe("Clé d'envoi : jamais la commande d'un autre, jamais un autre contenu", () => {
  test("un client ne peut ni retrouver ni réutiliser la commande d'un autre avec sa clé : refus sans information, rien n'est créé ni modifié", async () => {
    const x = await neuf(), y = await neuf(); const A = await produitStock(db, 'Produit X', 30);
    await remplirPanier(db, x.c, [[A, 4]]); await remplirPanier(db, y.c, [[A, 4]]);
    const k = cle();
    const rx = await traiterEnvoi({ depot: x.depot, userId: x.c.id, cle: k, createur: createurPglite(db, x.c) }); expect(rx.type).toBe('cree');
    const avantX = await commandesDe(db, x.c); const lignesX = await lignesCommande(db, avantX[0].id);
    const ry = await traiterEnvoi({ depot: y.depot, userId: y.c.id, cle: k, createur: createurPglite(db, y.c) });       // le client Y présente la clé de X
    expect(ry).toEqual({ type: 'erreur', code: 'CLE_DEJA_UTILISEE' });                                    // aucun identifiant de commande dans la réponse
    expect(JSON.stringify(ry)).not.toContain(avantX[0].id);
    expect(await commandesDe(db, y.c)).toHaveLength(0); expect(await panierDe(db, y.c)).toEqual({ [A]: 4 });   // Y : rien créé, panier conservé
    expect(await commandesDe(db, x.c)).toEqual(avantX); expect(await lignesCommande(db, avantX[0].id)).toEqual(lignesX);   // X : commande intacte
  });

  test("la même clé réutilisée avec un AUTRE contenu est refusée clairement : aucune nouvelle commande, la précédente n'est pas modifiée, le panier est conservé", async () => {
    const { c, depot } = await neuf(); const A = await produitStock(db, 'Boisson A', 40), B = await produitStock(db, 'Boisson B', 40);
    await remplirPanier(db, c, [[A, 3]]); const k = cle();
    expect((await traiterEnvoi({ depot, userId: c.id, cle: k, createur: createurPglite(db, c) })).type).toBe('cree');
    const [cmd] = await commandesDe(db, c); const lignes = await lignesCommande(db, cmd.id);
    await remplirPanier(db, c, [[A, 5], [B, 2]]);                                                         // le panier a changé depuis (autre onglet, ancienne page)
    const r = await createurPglite(db, c).creer(k, await depot.lireLignes(c.id));                        // même clé, autre contenu
    expect(r).toEqual({ ok: false, error: 'CLE_REUTILISEE_AUTRES_DONNEES' });
    expect(await commandesDe(db, c)).toHaveLength(1); expect(await lignesCommande(db, cmd.id)).toEqual(lignes);
    expect(await panierDe(db, c)).toEqual({ [A]: 5, [B]: 2 });                                            // panier conservé
    expect(await disponible(db, A)).toBe(37); expect(await disponible(db, B)).toBe(40);                   // aucune réservation de plus
    const re = await traiterEnvoi({ depot, userId: c.id, cle: k, createur: createurPglite(db, c) });      // via le flux complet : même refus explicite
    expect(re.type === 'erreur' && re.code).toBe('CLE_REUTILISEE_AUTRES_DONNEES');
  });

  test("la clé identifie le CONTENU, pas l'ordre des lignes ni leur découpage : le même panier renvoyé reste « déjà enregistré »", async () => {
    const { c } = await neuf(); const A = await produitStock(db, 'Contenu A', 30), B = await produitStock(db, 'Contenu B', 30); const k = cle();
    const creer = createurPglite(db, c); const ligne = (p: string, q: number) => ({ product_id: p, quantity: q, nom: 'n', unit: null });
    expect(await creer.creer(k, [ligne(A, 2), ligne(B, 3)])).toMatchObject({ ok: true, deja: false });
    expect(await creer.creer(k, [ligne(B, 3), ligne(A, 1), ligne(A, 1)])).toMatchObject({ ok: true, deja: true });   // autre ordre, ligne A découpée : même contenu
    expect(await commandesDe(db, c)).toHaveLength(1);
  });
});

test.describe('Sécurité des stocks, prix et permissions', () => {
  test('aucune commande ne réserve plus que le stock : 5 clients demandent 3 sur un stock de 10, exactement 3 réussissent', async () => {
    const A = await produitStock(db, 'Rareté', 10); const clients: Awaited<ReturnType<typeof neuf>>[] = [];
    for (let i = 0; i < 5; i++) { const x = await neuf(); await remplirPanier(db, x.c, [[A, 3]]); clients.push(x); }
    const res = await Promise.all(clients.map(x => traiterEnvoi({ depot: x.depot, userId: x.c.id, cle: cle(), createur: createurPglite(db, x.c) })));
    expect(res.filter(r => r.type === 'cree')).toHaveLength(3); expect(res.filter(r => r.type === 'conflits')).toHaveLength(2);
    expect(await disponible(db, A)).toBe(1);                                                              // 10 − 9, jamais négatif
    for (let i = 0; i < 5; i++) if (res[i].type === 'conflits') expect(await panierDe(db, clients[i].c)).toEqual({ [A]: 3 });   // les refusés gardent leur panier
  });

  test('prix, quantités et conditionnement de la commande = ceux du panier au moment de la création (instantanés) ; remise non touchée par cette logique', async () => {
    const { c, depot } = await neuf(); const A = await produitStock(db, 'Premium', 30, 18.4), B = await produitStock(db, 'Standard', 30, 7.25);
    await remplirPanier(db, c, [[A, 3], [B, 11]]);
    expect((await traiterEnvoi({ depot, userId: c.id, cle: cle(), createur: createurPglite(db, c) })).type).toBe('cree');
    const [cmd] = await commandesDe(db, c);
    const l = await exec(db, `SELECT product_id, quantity, price_ht_snapshot::float AS prix, tva_rate_snapshot::float AS tva FROM order_items WHERE order_id = $1`, [cmd.id]);
    expect(l.find(x => x.product_id === A)).toMatchObject({ quantity: 3, prix: 18.4, tva: 0.085 }); expect(l.find(x => x.product_id === B)).toMatchObject({ quantity: 11, prix: 7.25 });
  });

  test('produit masqué du catalogue : signalé et retirable explicitement (jamais retiré en silence) ; un client explicitement autorisé le garde', async () => {
    const { c, depot } = await neuf(); const autorise = await neuf();
    const V = await produitStock(db, 'Visible', 10), M = await produitStock(db, 'Masqué', 10);
    await db.query(`UPDATE products SET visible_catalogue = false WHERE id = $1`, [M]);
    await db.query(`INSERT INTO client_product_access (client_id, product_id) SELECT id, $2 FROM client_accounts WHERE email = $1`, [autorise.c.email, M]);
    await remplirPanier(db, c, [[V, 1], [M, 2]]); await remplirPanier(db, autorise.c, [[V, 1], [M, 2]]);
    const e = (await etatPanier(depot, c.id)).evaluations; expect(e.map(x => x.statut)).toEqual(['ok', 'retire_catalogue']);
    expect(await panierDe(db, c)).toEqual({ [V]: 1, [M]: 2 });                                            // l'état du panier n'a pas été modifié par le simple affichage
    expect((await traiterEnvoi({ depot, userId: c.id, cle: cle(), createur: createurPglite(db, c) })).type).toBe('conflits');
    expect((await etatPanier(autorise.depot, autorise.c.id)).plan).toHaveLength(0);                       // le client autorisé : rien à ajuster
    expect((await traiterEnvoi({ depot: autorise.depot, userId: autorise.c.id, cle: cle(), createur: createurPglite(db, autorise.c) })).type).toBe('cree');
  });

  test('compte non actif : refusé par la base, panier conservé', async () => {
    const c = await nouveauClient(db, ++n, 'en_attente'); const depot = depotPglite(db, c); const A = await produitStock(db, 'Test', 5);
    await remplirPanier(db, c, [[A, 1]]);
    expect(await traiterEnvoi({ depot, userId: c.id, cle: cle(), createur: createurPglite(db, c) })).toEqual({ type: 'erreur', code: 'COMPTE_NON_ACTIF' });
    expect(await panierDe(db, c)).toEqual({ [A]: 1 });
  });

  test("fonction sécurisée ABSENTE ou indisponible : l'envoi est refusé proprement, le panier est conservé, aucune commande n'est créée — jamais de repli silencieux", async () => {
    const base = await basePanier(false); const c = await nouveauClient(base, 99); const depot = depotPglite(base, c);   // migration d'idempotence NON appliquée
    const A = await produitStock(base, 'Sans migration', 10), B = await produitStock(base, 'Autre', 10); await remplirPanier(base, c, [[A, 2], [B, 1]]);
    const avant = await panierDe(base, c);
    // 1. la fonction n'existe pas dans la base : l'appel échoue, rien n'est créé
    const vrai = createurPglite(base, c);
    const r1 = await traiterEnvoi({ depot, userId: c.id, cle: cle(), createur: vrai });
    expect(r1.type).toBe('erreur'); expect(await commandesDe(base, c)).toHaveLength(0); expect(await panierDe(base, c)).toEqual(avant);
    // 2. ce que fait le site quand sa sonde constate l'absence : refus explicite, même résultat
    const r2 = await traiterEnvoi({ depot, userId: c.id, cle: cle(), createur: createurIndisponible() });
    expect(r2).toEqual({ type: 'erreur', code: 'ENVOI_INDISPONIBLE' });
    expect(await commandesDe(base, c)).toHaveLength(0); expect(await panierDe(base, c)).toEqual(avant);
    // 3. la base n'a PAS reçu d'ordre de création « classique » de repli : stock et réservations intacts
    expect(await disponible(base, A)).toBe(10); expect(await disponible(base, B)).toBe(10);
    await base.close();
  });

  test('flux de commande : nombre total de cartons réservés = somme des commandes réussies (aucune fuite, aucun doublon) sur un scénario mêlant refus, ajustements et doubles envois', async () => {
    const A = await produitStock(db, 'Cumul A', 12), B = await produitStock(db, 'Cumul B', 12);
    let attendu = 0;
    for (let i = 0; i < 6; i++) {
      const { c, depot } = await neuf(); await remplirPanier(db, c, [[A, 3], [B, 2]]);
      const k = cle(); const createur = createurPglite(db, c);
      let r = await traiterEnvoi({ depot, userId: c.id, cle: k, createur });
      if (r.type === 'conflits') { const ap = await apercuAjustement(depot, c.id); await confirmerAjustement(depot, c.id, ap.etat.signature); r = await traiterEnvoi({ depot, userId: c.id, cle: cle(), createur }); }
      await traiterEnvoi({ depot, userId: c.id, cle: k, createur });                                      // double envoi final
      attendu += total(await lignesCommande(db, (await commandesDe(db, c)).at(-1)?.id ?? '00000000-0000-4000-8000-000000000000').then(ls => Object.fromEntries(ls.map(l => [l.product_id, l.quantity]))));
      expect((await commandesDe(db, c)).length).toBeLessThanOrEqual(1);
    }
    expect((await disponible(db, A)) + (await disponible(db, B))).toBe(24 - attendu);
    expect(await disponible(db, A)).toBeGreaterThanOrEqual(0); expect(await disponible(db, B)).toBeGreaterThanOrEqual(0);
  });
});
