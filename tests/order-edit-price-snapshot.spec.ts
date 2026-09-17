/**
 * Régression — édition de commande et correction explicite du prix ligne
 *
 * Bug réel : une commande passée avec un produit dont le prix catalogue
 * était à 0 € par erreur restait figée à 0 € sur la ligne (order_items.
 * price_ht_snapshot), même après correction du prix produit ET modification
 * explicite de la commande par un admin — qui affichait pourtant "Commande
 * mise à jour avec succès". Cause : order_update_checked ne réécrivait que
 * `quantity` pour une ligne déjà présente ; l'écran d'édition n'envoyait
 * d'ailleurs aucun prix du tout au serveur (voir edit.astro).
 *
 * Comportement attendu (voir order_update_checked_price_refresh.sql et
 * src/pages/api/admin/orders/[id]/update.ts) :
 *   - par défaut, une ligne existante conserve son price_ht_snapshot ;
 *   - si l'admin édite explicitement le prix affiché sur une ligne, cette
 *     valeur est sauvegardée pour CETTE ligne uniquement ;
 *   - modifier uniquement une quantité (sur n'importe quelle ligne) ne doit
 *     JAMAIS changer le price_ht_snapshot d'une autre ligne, ni même de la
 *     sienne — pas de recalcul automatique depuis le catalogue.
 *
 * Ce fichier couvre les deux scénarios demandés :
 *   1. prix ligne initial = 0 € → correction explicite dans l'écran
 *      d'édition → sauvegarde → relecture = nouveau prix (et la ligne
 *      voisine, non éditée, reste inchangée) ;
 *   2. modification de quantité seule sur une ligne à prix historique →
 *      le prix doit rester inchangé, même si le prix catalogue du produit a
 *      changé entre-temps.
 *
 * Prérequis identiques à tests/e2e.spec.ts (.env : TEST_ADMIN_EMAIL,
 * TEST_ADMIN_PASSWORD, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY).
 */

import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

function getEnv(key: string): string {
  const v = process.env[key];
  if (!v) throw new Error(`Missing env var: ${key}. Add it to .env`);
  return v;
}

const RUN_ID       = String(Date.now()).slice(-6);
const TEST_EMAIL    = `e2e-price-${RUN_ID}@test.inca-import.local`;
const TEST_PASSWORD = 'E2ePlaywright2026!';

const CORRECTED_PRICE_A = 20.00; // nouveau prix explicitement saisi pour la ligne A dans l'écran d'édition
const HISTORIC_PRICE_B  = 9.99;  // prix historique de la ligne B, jamais touché depuis l'écran
const NEW_CATALOG_PRICE_B = 5.00; // prix catalogue de B modifié APRÈS la commande — ne doit jamais fuiter dans le snapshot

const state = {
  userId:      '',
  productAId:  '',
  productBId:  '',
  productAName: `__TEST__ Produit prix corrigé A ${RUN_ID}`,
  productBName: `__TEST__ Produit prix historique B ${RUN_ID}`,
  orderId:     '',
};

let db: SupabaseClient;
let ctx: BrowserContext;
let page: Page;

async function loginAsAdmin() {
  await page.goto('/admin/login');
  await page.fill('input[name="email"]', process.env.TEST_ADMIN_EMAIL!);
  await page.fill('input[name="password"]', process.env.TEST_ADMIN_PASSWORD!);
  await page.click('button[type="submit"]');
  await page.waitForURL(/\/admin($|\/)/, { timeout: 15_000 });
}

function rowFor(productName: string) {
  return page.locator('#itemsTable tr', { has: page.locator('.item-name', { hasText: productName }) });
}

async function readSnapshot(productId: string) {
  const { data, error } = await db
    .from('order_items')
    .select('price_ht_snapshot, quantity')
    .eq('order_id', state.orderId)
    .eq('product_id', productId)
    .single();
  expect(error).toBeNull();
  return { price: data?.price_ht_snapshot != null ? Number(data.price_ht_snapshot) : null, quantity: data?.quantity };
}

test.describe.serial('Commande — correction explicite du prix à l\'édition (régression)', () => {

  test.beforeAll(async ({ browser }) => {
    db = createClient(getEnv('SUPABASE_URL'), getEnv('SUPABASE_SERVICE_ROLE_KEY'), {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    getEnv('TEST_ADMIN_EMAIL');
    getEnv('TEST_ADMIN_PASSWORD');

    // Produit A : délibérément à 0 € — reproduit "prix de vente par erreur
    // à 0 €" du rapport de bug.
    const { data: prodA, error: prodAErr } = await db.from('products').insert({
      name: state.productAName, category: 'divers', unit: 'carton',
      price_ht: 0, tva_rate: 0.085, stock_quantity: 10, in_stock: true,
    }).select('id').single();
    expect(prodAErr, `product A insert failed: ${prodAErr?.message}`).toBeNull();
    state.productAId = prodA!.id;

    // Produit B : prix "normal" dès le départ, sert à vérifier qu'éditer/
    // sauvegarder la commande (ligne A) ou changer sa quantité (ligne B)
    // ne touche jamais à ce prix historique.
    const { data: prodB, error: prodBErr } = await db.from('products').insert({
      name: state.productBName, category: 'divers', unit: 'carton',
      price_ht: HISTORIC_PRICE_B, tva_rate: 0.085, stock_quantity: 10, in_stock: true,
    }).select('id').single();
    expect(prodBErr, `product B insert failed: ${prodBErr?.message}`).toBeNull();
    state.productBId = prodB!.id;

    ctx  = await browser.newContext();
    page = await ctx.newPage();
  });

  test.afterAll(async () => {
    if (state.orderId) {
      await db.from('order_items').delete().eq('order_id', state.orderId);
      await db.from('orders').delete().eq('id', state.orderId);
    }
    if (state.userId) {
      await db.from('client_accounts').delete().eq('email', TEST_EMAIL);
      await db.auth.admin.deleteUser(state.userId);
    }
    if (state.productAId) await db.from('products').delete().eq('id', state.productAId);
    if (state.productBId) await db.from('products').delete().eq('id', state.productBId);
    await ctx.close();
  });

  test('0. Commande passée avec A à 0€ et B à son prix normal', async () => {
    const { data, error } = await db.auth.admin.createUser({
      email: TEST_EMAIL, password: TEST_PASSWORD, email_confirm: true,
      user_metadata: { role: 'client', nom: 'Playwright Price E2E', societe: 'Test Price SARL', telephone: '0692000001' },
    });
    expect(error, `createUser failed: ${error?.message}`).toBeNull();
    state.userId = data!.user!.id;

    const { error: caErr } = await db.from('client_accounts').insert({
      nom: 'Playwright Price E2E', email: TEST_EMAIL, telephone: '0692000001',
      points_de_vente: 'Test Price PDV', status: 'actif',
    });
    expect(caErr, `client_accounts insert failed: ${caErr?.message}`).toBeNull();

    await page.goto('/connexion/client');
    await page.fill('input[name="email"]', TEST_EMAIL);
    await page.fill('input[name="password"]', TEST_PASSWORD);
    await page.click('button[type="submit"]');
    await page.waitForURL('**/catalogue', { timeout: 15_000 });

    for (const productId of [state.productAId, state.productBId]) {
      const addRes = await page.request.post('/api/cart/add', {
        data:    { productId, qty: 1 },
        headers: { 'Content-Type': 'application/json' },
      });
      expect(addRes.status(), `Cart add failed with ${addRes.status()}: ${await addRes.text()}`).toBe(200);
    }

    await page.goto('/commande');
    await expect(page.locator('body')).toContainText(state.productAName, { timeout: 8_000 });
    await expect(page.locator('body')).toContainText(state.productBName, { timeout: 8_000 });
    await page.click('button.confirm-btn');
    await page.waitForURL(/\/commande\?success=1/, { timeout: 15_000 });

    const url = new URL(page.url());
    state.orderId = url.searchParams.get('order') ?? '';
    expect(state.orderId, 'Order ID missing from redirect URL').toBeTruthy();

    const a = await readSnapshot(state.productAId);
    expect(a.price, 'Ligne A initiale doit être à 0€, comme le bug réel').toBe(0);
    const b = await readSnapshot(state.productBId);
    expect(b.price, 'Ligne B initiale au prix normal').toBe(HISTORIC_PRICE_B);
  });

  test('1. Correction explicite du prix de la ligne A dans l\'écran d\'édition → sauvegarde → relecture', async () => {
    // Le catalogue est corrigé après coup (comme dans le cas réel), mais ce
    // n'est PAS cette valeur catalogue qui doit se retrouver sur la ligne —
    // seule la saisie explicite dans le formulaire compte.
    const { error: prodAUpdateErr } = await db.from('products').update({ price_ht: CORRECTED_PRICE_A }).eq('id', state.productAId);
    expect(prodAUpdateErr).toBeNull();

    await loginAsAdmin();
    await page.goto(`/admin/commandes/${state.orderId}/edit`);
    await expect(page.locator('#submitBtn')).toBeVisible({ timeout: 8_000 });

    // Seule la ligne A est éditée — son champ prix est rempli explicitement.
    // La ligne B n'est touchée ni en prix ni en quantité.
    await rowFor(state.productAName).locator('.price-input').fill(String(CORRECTED_PRICE_A));

    await page.click('#submitBtn');
    await page.waitForURL(/\/admin\/commandes\?updated=1/, { timeout: 15_000 });

    const a = await readSnapshot(state.productAId);
    expect(a.price, 'price_ht_snapshot de A doit refléter la valeur explicitement saisie').toBe(CORRECTED_PRICE_A);

    const b = await readSnapshot(state.productBId);
    expect(b.price, 'La ligne B, non éditée, ne doit pas bouger quand on corrige A').toBe(HISTORIC_PRICE_B);
  });

  test('2. Modification de quantité seule sur B → son prix historique reste inchangé', async () => {
    // Le prix catalogue de B change aussi entre-temps — ce changement ne
    // doit jamais fuiter dans le snapshot via une simple édition de qté.
    const { error: prodBUpdateErr } = await db.from('products').update({ price_ht: NEW_CATALOG_PRICE_B }).eq('id', state.productBId);
    expect(prodBUpdateErr).toBeNull();

    await page.goto(`/admin/commandes/${state.orderId}/edit`);
    await expect(page.locator('#submitBtn')).toBeVisible({ timeout: 8_000 });

    // Uniquement la quantité de B change ; aucun champ prix n'est touché,
    // ni pour A ni pour B.
    await rowFor(state.productBName).locator('.qty-input').fill('2');

    await page.click('#submitBtn');
    await page.waitForURL(/\/admin\/commandes\?updated=1/, { timeout: 15_000 });

    const b = await readSnapshot(state.productBId);
    expect(b.quantity, 'La quantité de B doit être mise à jour').toBe(2);
    expect(
      b.price,
      'Le prix historique de B ne doit pas bouger suite à une édition de quantité seule, même si le catalogue a changé entre-temps',
    ).toBe(HISTORIC_PRICE_B);

    const a = await readSnapshot(state.productAId);
    expect(a.price, 'Le prix de A (corrigé au test précédent) ne doit pas non plus bouger').toBe(CORRECTED_PRICE_A);
  });
});
