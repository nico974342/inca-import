/**
 * PARCOURS COMPLET de l'envoi d'une commande, de bout en bout et en environnement isolé :
 *   navigateur réel (Chromium) → formulaire et script RÉELS de commande.astro → requête HTTP → logique serveur RÉELLE (traiterEnvoi, createur, vérification « commande enregistrée ? »)
 *   → fonctions SQL RÉELLES (migrations du dépôt, base PGlite en mémoire).
 * Aucune connexion distante, aucune écriture en production. Seul le décor HTTP (un petit serveur local) remplace Astro et Supabase.
 */
import { test, expect } from '@playwright/test';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { PGlite } from '@electric-sql/pglite';
import { basePanier, nouveauClient, produitStock, remplirPanier, panierDe, commandesDe, lignesCommande, disponible, depotPglite, createurPglite, type Client } from './helpers/panierBase';
import { exec } from './helpers/panierBaseCommun';
import { traiterEnvoi } from '../src/lib/commandeActions';
import { pageAvecFormulaire } from './helpers/formulaireCommande';

let db: PGlite; let n = 100;
test.beforeAll(async () => { db = await basePanier(true); });
test.afterAll(async () => { await db.close(); });

type Panne = 'aucune' | 'avant_creation' | 'reponse_perdue';
type Requete = { methode: string; chemin: string; champs?: Record<string, string> };

/** Mini-serveur du site : GET /commande (formulaire réel), POST /commande (logique réelle), GET /api/commande/statut (vérification après coupure). */
async function demarrer(c: Client, panne: { v: Panne }, cleAffichee: string) {
  const journal: Requete[] = [];
  const depot = depotPglite(db, c); const createur = createurPglite(db, c);
  const serveur = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (req.method === 'POST' && url.pathname === '/commande') {
      const corps = await new Response(req as any, { headers: req.headers as any, method: 'POST', duplex: 'half' } as any).formData().catch(() => null);
      const champs = corps ? Object.fromEntries([...corps.entries()].map(([k, v]) => [k, String(v)])) : undefined;
      journal.push({ methode: 'POST', chemin: url.pathname, champs });
      if (!champs) { res.statusCode = 400; return res.end('?'); }
      if (panne.v === 'avant_creation') { req.socket.destroy(); return; }
      const r = await traiterEnvoi({ depot, userId: c.id, cle: champs.cle, createur });
      if (panne.v === 'reponse_perdue' && (r.type === 'cree' || r.type === 'deja_enregistree')) { req.socket.destroy(); return; }
      res.statusCode = 303;
      res.setHeader('Location', r.type === 'cree' || r.type === 'deja_enregistree' ? `/commande?success=1&order=${r.orderId}` : r.type === 'conflits' ? '/commande?error=stock' : '/commande?error=1');
      return res.end();
    }
    if (req.method === 'GET' && url.pathname === '/api/commande/statut') {
      journal.push({ methode: 'GET', chemin: url.pathname + url.search });
      const l = await exec(db, `SELECT id FROM orders WHERE user_id = $1 AND cle_commande = $2`, [c.id, url.searchParams.get('cle')]);
      res.setHeader('Content-Type', 'application/json');
      return res.end(JSON.stringify(l.length ? { enregistree: true, orderId: l[0].id } : { enregistree: false }));
    }
    if (req.method === 'GET' && url.pathname === '/commande') {
      journal.push({ methode: 'GET', chemin: url.pathname + url.search });
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      if (url.searchParams.get('success')) return res.end(`<!doctype html><p id="succes">Commande reçue ${url.searchParams.get('order')}</p>`);
      if (url.searchParams.get('error')) return res.end(pageAvecFormulaire(cleAffichee, `<p id="refus">refus : ${url.searchParams.get('error')}</p>`));
      return res.end(pageAvecFormulaire(cleAffichee));
    }
    res.statusCode = 404; res.end('introuvable');
  });
  await new Promise<void>(ok => serveur.listen(0, '127.0.0.1', ok));
  return { base: `http://127.0.0.1:${(serveur.address() as AddressInfo).port}`, journal, fermer: () => new Promise<void>(ok => serveur.close(() => ok())) };
}
const posts = (j: Requete[]) => j.filter(r => r.methode === 'POST');

test.describe('Envoi de la commande : parcours complet (navigateur → serveur → base)', () => {
  test('commande réussie : POST vers /commande avec les bonnes données, UNE commande, lignes et prix exacts, stock réservé, panier vidé, page de succès', async ({ page }) => {
    const c = await nouveauClient(db, ++n); const A = await produitStock(db, 'Cola', 30, 12), B = await produitStock(db, 'Chips', 10, 4);
    await remplirPanier(db, c, [[A, 5], [B, 2]]);
    const cle = crypto.randomUUID(); const s = await demarrer(c, { v: 'aucune' }, cle);
    try {
      await page.goto(`${s.base}/commande`);
      await page.locator('#notes').fill('livraison le matin');
      await page.getByTestId('envoyer').click();
      await expect(page.locator('#succes')).toBeVisible();

      expect(posts(s.journal)).toHaveLength(1);
      expect(posts(s.journal)[0].chemin).toBe('/commande');
      expect(posts(s.journal)[0].champs).toMatchObject({ action: 'envoyer', cle, notes: 'livraison le matin' });
      const cmds = await commandesDe(db, c);
      expect(cmds).toHaveLength(1);
      expect(await lignesCommande(db, cmds[0].id)).toEqual(expect.arrayContaining([expect.objectContaining({ product_id: A, quantity: 5 }), expect.objectContaining({ product_id: B, quantity: 2 })]));
      expect(cmds[0].cle_commande).toBe(cle);                       // la clé d'envoi est bien posée sur la commande
      expect(await disponible(db, A)).toBe(25); expect(await disponible(db, B)).toBe(8);     // 5 et 2 réservés, une seule fois
      expect(await panierDe(db, c)).toEqual({});                    // vidé APRÈS la création confirmée
      expect(page.url()).toContain(`order=${cmds[0].id}`);
    } finally { await s.fermer(); }
  });

  test('double clic rapide : une seule requête partie, une seule commande, un seul jeu de réservations', async ({ page }) => {
    const c = await nouveauClient(db, ++n); const A = await produitStock(db, 'Lait', 20);
    await remplirPanier(db, c, [[A, 4]]);
    const s = await demarrer(c, { v: 'aucune' }, crypto.randomUUID());
    try {
      await page.goto(`${s.base}/commande`);
      await page.getByTestId('envoyer').dblclick();
      await expect(page.locator('#succes')).toBeVisible();
      expect(posts(s.journal)).toHaveLength(1);
      expect(await commandesDe(db, c)).toHaveLength(1);
      expect(await disponible(db, A)).toBe(16);
    } finally { await s.fermer(); }
  });

  test('coupure APRÈS la création (réponse perdue) : le site vérifie, retrouve la commande, affiche le succès ; aucune seconde commande ; un renvoi de la même clé ne recrée rien', async ({ page }) => {
    const c = await nouveauClient(db, ++n); const A = await produitStock(db, 'Thé', 20);
    await remplirPanier(db, c, [[A, 3]]);
    const cle = crypto.randomUUID(); const s = await demarrer(c, { v: 'reponse_perdue' }, cle);
    try {
      await page.goto(`${s.base}/commande`);
      await page.getByTestId('envoyer').click();
      await expect(page.locator('#succes')).toBeVisible();          // « Connexion interrompue — vérification… » puis succès
      const cmds = await commandesDe(db, c);
      expect(cmds).toHaveLength(1);
      expect(s.journal.some(r => r.chemin.startsWith('/api/commande/statut') && r.chemin.includes(`cle=${cle}`))).toBe(true);
      expect(page.url()).toContain(`order=${cmds[0].id}`);
      expect(await disponible(db, A)).toBe(17);
      // renvoi tardif de la même clé (page ancienne, deuxième onglet) : rien n'est recréé
      const r = await traiterEnvoi({ depot: depotPglite(db, c), userId: c.id, cle, createur: createurPglite(db, c) });
      expect(['deja_enregistree', 'panier_vide']).toContain(r.type);
      expect(await commandesDe(db, c)).toHaveLength(1); expect(await disponible(db, A)).toBe(17);
    } finally { await s.fermer(); }
  });

  test('coupure AVANT la création : message « non enregistrée », panier conservé à l\'identique, bouton rouvert, même clé ; le nouvel essai crée UNE commande', async ({ page }) => {
    const c = await nouveauClient(db, ++n); const A = await produitStock(db, 'Sirop', 12), B = await produitStock(db, 'Miel', 12);
    await remplirPanier(db, c, [[A, 2], [B, 3]]); const avant = await panierDe(db, c);
    const panne = { v: 'avant_creation' as Panne }; const cle = crypto.randomUUID(); const s = await demarrer(c, panne, cle);
    try {
      await page.goto(`${s.base}/commande`);
      await page.getByTestId('envoyer').click();
      await expect(page.locator('#envoi-etat')).toContainText('n\'a pas été enregistrée');
      await expect(page.getByTestId('envoyer')).toBeEnabled();
      expect(await commandesDe(db, c)).toHaveLength(0); expect(await panierDe(db, c)).toEqual(avant);
      panne.v = 'aucune';                                           // le réseau revient
      await page.getByTestId('envoyer').click();
      await expect(page.locator('#succes')).toBeVisible();
      const cles = posts(s.journal).map(p => p.champs?.cle);
      expect(cles.length).toBeGreaterThanOrEqual(2);                // le navigateur peut lui-même renvoyer une requête coupée : c'est la clé qui protège
      expect(new Set(cles)).toEqual(new Set([cle]));                // la MÊME clé à chaque essai
      expect(await commandesDe(db, c)).toHaveLength(1);
      expect(await disponible(db, A)).toBe(10); expect(await disponible(db, B)).toBe(9);
    } finally { await s.fermer(); }
  });

  test('stock insuffisant : refus sans rien créer, panier conservé, aucune réservation', async ({ page }) => {
    const c = await nouveauClient(db, ++n); const A = await produitStock(db, 'Rare', 2);
    await remplirPanier(db, c, [[A, 5]]);
    const s = await demarrer(c, { v: 'aucune' }, crypto.randomUUID());
    try {
      await page.goto(`${s.base}/commande`);
      await page.getByTestId('envoyer').click();
      await expect(page.locator('#refus')).toContainText('stock');
      expect(await commandesDe(db, c)).toHaveLength(0); expect(await panierDe(db, c)).toEqual({ [A]: 5 }); expect(await disponible(db, A)).toBe(2);
    } finally { await s.fermer(); }
  });
});
