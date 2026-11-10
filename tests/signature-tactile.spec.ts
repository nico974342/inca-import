/**
 * Écran « Faire signer » en conditions tactiles : vrais événements de doigt (CDP), vrai style et vrais scripts de la page,
 * API simulée (aucune connexion à Supabase, aucune écriture en production).
 */
import { test, expect, devices, type Page, type CDPSession } from '@playwright/test';
import { readFileSync, mkdirSync } from 'node:fs';
import { validerImageSignature } from '../src/lib/signatureBl';

const ORIGINE = 'http://harness.test';
const page_astro = readFileSync('src/pages/admin/bl/[id]/signer.astro', 'utf8');
const CSS = page_astro.slice(page_astro.indexOf('<style is:global>') + 17, page_astro.indexOf('</style>'));
const PAD_JS = readFileSync('public/js/signature-pad.js', 'utf8');
const SIGNER_JS = readFileSync('public/js/signer-bl.js', 'utf8');
const CAPTURES = process.env.CAPTURES_DIR;   // facultatif : dossier où enregistrer des captures d'écran

// Même structure que src/pages/admin/bl/[id]/signer.astro (un test vérifie que les identifiants du script existent dans la page).
const HTML = `<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<style>${CSS}</style></head><body class="sg-body"><main class="sg-shell">
<header class="sg-entete"><div><p class="sg-etiquette">Bon de livraison</p><h1 class="sg-numero">BL-0042</h1></div><a class="sg-retour" href="#">← Livraisons</a></header>
<section class="sg-recap"><dl><div><dt>Client</dt><dd>SARL Les Palmiers</dd></div><div><dt>Point de vente</dt><dd>Station Total Saint-Gilles</dd></div><div><dt>Cartons</dt><dd>38</dd></div><div><dt>Date</dt><dd>10/11/2026</dd></div></dl></section>
<ol class="sg-etapes"><li class="sg-etape" data-role="transporteur" data-etat="attente"><span class="sg-puce">1</span><span>Transporteur</span></li><li class="sg-etape" data-role="destinataire" data-etat="attente"><span class="sg-puce">2</span><span>Destinataire</span></li></ol>
<section id="panneau" class="sg-panneau"><h2 id="sg-titre" class="sg-titre"></h2>
<label class="sg-label" for="sg-nom" id="sg-nom-label">Nom du signataire</label><input id="sg-nom" class="sg-champ" type="text" maxlength="100">
<p class="sg-sr" id="sg-cadre-label">Zone de signature</p>
<div class="sg-cadre" id="sg-cadre"><canvas id="pad" class="sg-pad"></canvas><span class="sg-indice" id="sg-indice">Signez ici</span></div>
<div class="sg-actions"><button type="button" id="sg-effacer" class="sg-btn sg-btn--sec" disabled>Effacer</button><button type="button" id="sg-valider" class="sg-btn sg-btn--prim" disabled>Valider la signature</button></div>
<p class="sg-aide" id="sg-aide" aria-live="polite"></p></section>
<div id="sg-statut" class="sg-statut" role="status" aria-live="polite" hidden></div>
<section id="sg-fin" class="sg-fin" hidden><p class="sg-fin-titre">Bon de livraison signé</p><a class="sg-btn sg-btn--prim" href="/api/delivery-notes/NOTE/signe" id="lien-signe">Télécharger le BL signé</a></section>
<script id="sg-config" type="application/json">${JSON.stringify({ noteId: '11111111-1111-1111-1111-111111111111', etapes: ['transporteur', 'destinataire'], nomParDefaut: 'Gérald Incana', blNumber: 'BL-0042' })}</script>
</main></body></html>`;

type Appel = { role: string; signataire_nom: string; signature_data: string; delivery_note_id: string };
type Reponse = 'ok' | 'reseau' | '500' | '409' | '401';

async function ouvrir(page: Page, comportement: () => Reponse) {
  const appels: Appel[] = [];
  page.on('pageerror', e => console.log('ERREUR PAGE:', e.message));
  page.on('console', m => { if (m.type() === 'error') console.log('CONSOLE:', m.text()); });
  await page.route(`${ORIGINE}/**`, async route => {
    const url = new URL(route.request().url());
    if (url.pathname === '/') return route.fulfill({ contentType: 'text/html', body: HTML });
    if (url.pathname === '/js/signature-pad.js') return route.fulfill({ contentType: 'text/javascript', body: PAD_JS });
    if (url.pathname === '/js/signer-bl.js') return route.fulfill({ contentType: 'text/javascript', body: SIGNER_JS });
    if (url.pathname === '/api/admin/bl-signatures') {
      appels.push(JSON.parse(route.request().postData() ?? '{}'));
      const c = comportement();
      if (c === 'reseau') return route.abort('connectionfailed');
      if (c === '500') return route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ ok: false, erreur: 'Erreur serveur' }) });
      if (c === '409') return route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ ok: false, erreur: 'Le transporteur a déjà signé ce bon de livraison.' }) });
      if (c === '401') return route.fulfill({ status: 401, contentType: 'text/plain', body: 'Non autorisé' });
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, etat: 'partiel', signed_at: new Date().toISOString() }) });
    }
    return route.fulfill({ status: 404, body: '' });
  });
  await page.goto(ORIGINE + '/');
  await page.addScriptTag({ url: ORIGINE + '/js/signature-pad.js' });
  await page.addScriptTag({ url: ORIGINE + '/js/signer-bl.js' });
  return appels;
}

/** Appui bref (touchStart + touchEnd) : même canal que le tracé, pour un état tactile cohérent. */
async function appui(cdp: CDPSession, x: number, y: number) {
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
}
/** Bouton : clic (le tracé, lui, utilise de vrais événements tactiles ; le banc de test ne génère pas le « click » d'un appui tactile brut). */
async function toucher(page: Page, _cdp: CDPSession, cible: ReturnType<Page['locator']>) {
  await cible.click();
}

async function signerAuDoigt(page: Page, cdp: CDPSession, variante = 0) {
  const b = (await page.locator('#pad').boundingBox())!;
  const pts = Array.from({ length: 40 }, (_, i) => ({
    x: b.x + b.width * (0.1 + 0.8 * i / 39),
    y: b.y + b.height * (0.5 + 0.25 * Math.sin(i / 3 + variante)),
  }));
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [pts[0]] });
  for (const p of pts.slice(1)) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [p] });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
}

for (const [nomAppareil, config] of [
  ['téléphone (Pixel 7, portrait)', (({ defaultBrowserType, ...reste }) => reste)(devices['Pixel 7'])],
  ['tablette (820 × 1180)', { viewport: { width: 820, height: 1180 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 }],
] as const) {
  test.describe(`Écran de signature — ${nomAppareil}`, () => {
    test.use(config as any);
    let cdp: CDPSession;
    test.beforeEach(async ({ page }) => { cdp = await page.context().newCDPSession(page); });

    test('gabarit terrain : zone pleine largeur, gros éléments, pas de défilement horizontal', async ({ page }) => {
      await ouvrir(page, () => 'ok');
      const vw = page.viewportSize()!.width;
      const pad = (await page.locator('#pad').boundingBox())!;
      expect(pad.width).toBeGreaterThanOrEqual(Math.min(vw - 40, 700));
      expect(pad.height).toBeGreaterThanOrEqual(190);
      for (const sel of ['#sg-nom', '#sg-effacer', '#sg-valider']) {
        const h = (await page.locator(sel).boundingBox())!.height;
        expect(h, sel).toBeGreaterThanOrEqual(60);
      }
      expect((await page.locator('#sg-valider').boundingBox())!.width).toBeGreaterThanOrEqual(150);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      expect(await page.evaluate(() => getComputedStyle(document.getElementById('pad')!).touchAction)).toBe('none');
      expect(await page.inputValue('#sg-nom')).toBe('Gérald Incana');   // nom du transporteur pré-rempli
      if (CAPTURES) { mkdirSync(CAPTURES, { recursive: true }); await page.screenshot({ path: `${CAPTURES}/signature-vide-${vw}.png`, fullPage: true }); }
    });

    test('un simple appui ne vaut pas signature ; un vrai tracé au doigt oui ; « Effacer » recommence', async ({ page }) => {
      await ouvrir(page, () => 'ok');
      const b = (await page.locator('#pad').boundingBox())!;
      await appui(cdp, b.x + b.width / 2, b.y + b.height / 2);
      await expect(page.locator('#sg-valider')).toBeDisabled();
      await signerAuDoigt(page, cdp);
      await expect(page.locator('#sg-valider')).toBeEnabled();
      await expect(page.locator('#sg-cadre')).toHaveAttribute('data-trace', '1');
      await toucher(page, cdp, page.locator('#sg-effacer'));
      await expect(page.locator('#sg-valider')).toBeDisabled();
      await expect(page.locator('#sg-cadre')).toHaveAttribute('data-trace', '0');
      expect(await page.evaluate(() => (document.getElementById('sg-aide') as HTMLElement).textContent)).toContain('Signez');
    });

    test('parcours complet : transporteur puis destinataire, enregistrés immédiatement, images valides côté serveur', async ({ page }) => {
      const appels = await ouvrir(page, () => 'ok');
      await signerAuDoigt(page, cdp);
      await toucher(page, cdp, page.locator('#sg-valider'));
      await expect(page.locator('#sg-statut')).toContainText('Signature du transporteur enregistrée');
      expect(appels).toHaveLength(1);
      expect(appels[0].role).toBe('transporteur');
      expect(appels[0].signataire_nom).toBe('Gérald Incana');
      expect(appels[0].delivery_note_id).toBe('11111111-1111-1111-1111-111111111111');
      const v = validerImageSignature(appels[0].signature_data);
      expect(v.ok, JSON.stringify(v)).toBe(true);   // PNG réel, tracé assez fourni, produit par le vrai navigateur
      if (CAPTURES) await page.screenshot({ path: `${CAPTURES}/signature-confirmation-${page.viewportSize()!.width}.png` });

      await toucher(page, cdp, page.locator('[data-testid="sg-suite"], #sg-suite'));
      await expect(page.locator('#sg-titre')).toContainText('destinataire');
      expect(await page.inputValue('#sg-nom')).toBe('');                 // nom du destinataire à saisir
      await signerAuDoigt(page, cdp, 1.5);
      await expect(page.locator('#sg-valider')).toBeDisabled();          // tracé fait mais nom manquant
      await page.locator('#sg-nom').fill('Marie Client');
      if (CAPTURES) await page.screenshot({ path: `${CAPTURES}/signature-destinataire-${page.viewportSize()!.width}.png`, fullPage: true });
      await toucher(page, cdp, page.locator('#sg-valider'));
      await expect(page.locator('#sg-statut')).toContainText('Signature du destinataire enregistrée');
      expect(appels[1].role).toBe('destinataire');
      expect(appels[1].signataire_nom).toBe('Marie Client');
      expect(validerImageSignature(appels[1].signature_data).ok).toBe(true);
      await toucher(page, cdp, page.locator('#sg-suite'));
      await expect(page.locator('#sg-fin')).toBeVisible();
      await expect(page.locator('#lien-signe')).toBeVisible();
      await expect(page.locator('.sg-etape[data-etat="fait"]')).toHaveCount(2);
    });

    test('mauvaise connexion : jamais de faux « enregistré » ; signature conservée ; réessai possible', async ({ page }) => {
      let mode: Reponse = 'reseau';
      const appels = await ouvrir(page, () => mode);
      await signerAuDoigt(page, cdp);
      await toucher(page, cdp, page.locator('#sg-valider'));
      await expect(page.locator('#sg-statut')).toContainText('NON enregistrée', { timeout: 15_000 });
      expect(appels.length).toBe(3);                                      // 3 tentatives automatiques
      await expect(page.locator('#sg-statut')).not.toContainText('enregistrée ✓');
      await expect(page.locator('.sg-statut--ok')).toHaveCount(0);
      await expect(page.locator('.sg-etape[data-etat="fait"]')).toHaveCount(0);
      expect(await page.evaluate(() => Object.keys(localStorage).filter(k => k.startsWith('blsig:')).length)).toBe(1);   // sauvegarde de secours
      if (CAPTURES) await page.screenshot({ path: `${CAPTURES}/signature-echec-${page.viewportSize()!.width}.png`, fullPage: true });
      mode = 'ok';
      await toucher(page, cdp, page.locator('#sg-reessayer'));
      await expect(page.locator('#sg-statut')).toContainText('Signature du transporteur enregistrée');
      expect(appels.at(-1)!.signature_data).toBe(appels[0].signature_data);   // la MÊME signature est renvoyée
      expect(await page.evaluate(() => Object.keys(localStorage).filter(k => k.startsWith('blsig:')).length)).toBe(0);
    });

    test('erreurs passagères du serveur : réessai automatique puis succès', async ({ page }) => {
      let n = 0;
      const appels = await ouvrir(page, () => (++n < 3 ? '500' : 'ok'));
      await signerAuDoigt(page, cdp);
      await toucher(page, cdp, page.locator('#sg-valider'));
      await expect(page.locator('#sg-statut')).toContainText('Signature du transporteur enregistrée', { timeout: 15_000 });
      expect(appels).toHaveLength(3);
    });

    test('refus du serveur (déjà signé) ou session expirée : message clair, pas de succès affiché, pas de réessai en boucle', async ({ page }) => {
      let mode: Reponse = '409';
      const appels = await ouvrir(page, () => mode);
      await signerAuDoigt(page, cdp);
      await toucher(page, cdp, page.locator('#sg-valider'));
      await expect(page.locator('#sg-statut')).toContainText('a déjà signé');
      expect(appels).toHaveLength(1);
      await expect(page.locator('.sg-statut--ok')).toHaveCount(0);
      mode = '401';
      await toucher(page, cdp, page.locator('#sg-reessayer'));
      await expect(page.locator('#sg-statut')).toContainText('session a expiré');
      await expect(page.locator('.sg-statut--ok')).toHaveCount(0);
    });

    test('signature non envoyée retrouvée après un rechargement de la page', async ({ page }) => {
      const appels = await ouvrir(page, () => 'reseau');
      await signerAuDoigt(page, cdp);
      await toucher(page, cdp, page.locator('#sg-valider'));
      await expect(page.locator('#sg-statut')).toContainText('NON enregistrée', { timeout: 15_000 });
      const envoyee = appels[0].signature_data;
      await page.unroute(`${ORIGINE}/**`);
      const appels2 = await ouvrir(page, () => 'ok');   // « rechargement »
      await expect(page.locator('#sg-statut')).toContainText('retrouvée');
      await toucher(page, cdp, page.locator('#sg-reessayer'));
      await expect(page.locator('#sg-statut')).toContainText('Signature du transporteur enregistrée');
      expect(appels2[0].signature_data).toBe(envoyee);
    });

    test('rotation de l\'écran : le tracé est conservé et l\'image enregistrée reste complète', async ({ page }) => {
      const appels = await ouvrir(page, () => 'ok');
      await signerAuDoigt(page, cdp);
      const { width, height } = page.viewportSize()!;
      await page.setViewportSize({ width: height, height: width });
      await expect(page.locator('#sg-cadre')).toHaveAttribute('data-trace', '1');
      await expect(page.locator('#sg-valider')).toBeEnabled();
      await page.locator('#sg-valider').click();
      await expect(page.locator('#sg-statut')).toContainText('enregistrée');
      expect(validerImageSignature(appels[0].signature_data).ok).toBe(true);
    });
  });
}
