/**
 * Régression — édition de commande et rafraîchissement du prix snapshot
 *
 * Bug réel : une commande passée avec un produit dont le prix catalogue
 * était à 0 € par erreur restait figée à 0 € sur la ligne (order_items.
 * price_ht_snapshot) même après correction du prix produit ET modification
 * explicite de la commande par un admin (qui affichait pourtant "Commande
 * mise à jour avec succès"). Cause : order_update_checked ne ré-évaluait
 * que `quantity` pour une ligne déjà présente, jamais price_ht_snapshot /
 * tva_rate_snapshot / pump_snapshot (voir supabase/migrations/
 * order_update_checked_price_refresh.sql et src/pages/api/admin/orders/
 * [id]/update.ts).
 *
 * Reproduit exactement : prix ligne initial = 0 € → nouveau prix produit →
 * modification commande (édition admin, même quantité) → sauvegarde →
 * relecture commande = nouveau prix.
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

const RUN_ID           = String(Date.now()).slice(-6);
const TEST_EMAIL        = `e2e-price-${RUN_ID}@test.inca-import.local`;
const TEST_PASSWORD     = 'E2ePlaywright2026!';
const CORRECTED_PRICE   = 15.5;

const state = {
  userId:      '',
  productId:   '',
  productName: `__TEST__ Produit prix corrigé ${RUN_ID}`,
  orderId:     '',
};

let db: SupabaseClient;
let ctx: BrowserContext;
let page: Page;

test.describe.serial('Commande — rafraîchissement du prix à l\'édition (régression)', () => {

  test.beforeAll(async ({ browser }) => {
    db = createClient(getEnv('SUPABASE_URL'), getEnv('SUPABASE_SERVICE_ROLE_KEY'), {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    getEnv('TEST_ADMIN_EMAIL');
    getEnv('TEST_ADMIN_PASSWORD');

    // Produit jetable, délibérément à 0 € — reproduit "prix de vente par
    // erreur à 0 €" du rapport de bug.
    const { data: prod, error: prodErr } = await db.from('products').insert({
      name:           state.productName,
      category:       'divers',
      unit:           'carton',
      price_ht:       0,
      tva_rate:       0.085,
      stock_quantity: 10,
      in_stock:       true,
    }).select('id').single();
    expect(prodErr, `product insert failed: ${prodErr?.message}`).toBeNull();
    state.productId = prod!.id;

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
    if (state.productId) {
      await db.from('products').delete().eq('id', state.productId);
    }
    await ctx.close();
  });

  test('1. Commande passée avec le produit à 0€ (état initial du bug)', async () => {
    const { data, error } = await db.auth.admin.createUser({
      email:         TEST_EMAIL,
      password:      TEST_PASSWORD,
      email_confirm: true,
      user_metadata: {
        role:      'client',
        nom:       'Playwright Price E2E',
        societe:   'Test Price SARL',
        telephone: '0692000001',
      },
    });
    expect(error, `createUser failed: ${error?.message}`).toBeNull();
    state.userId = data!.user!.id;

    const { error: caErr } = await db.from('client_accounts').insert({
      nom:             'Playwright Price E2E',
      email:           TEST_EMAIL,
      telephone:       '0692000001',
      points_de_vente: 'Test Price PDV',
      status:          'actif',
    });
    expect(caErr, `client_accounts insert failed: ${caErr?.message}`).toBeNull();

    await page.goto('/connexion/client');
    await page.fill('input[name="email"]', TEST_EMAIL);
    await page.fill('input[name="password"]', TEST_PASSWORD);
    await page.click('button[type="submit"]');
    await page.waitForURL('**/catalogue', { timeout: 15_000 });

    const addRes = await page.request.post('/api/cart/add', {
      data:    { productId: state.productId, qty: 1 },
      headers: { 'Content-Type': 'application/json' },
    });
    expect(addRes.status(), `Cart add failed with ${addRes.status()}: ${await addRes.text()}`).toBe(200);

    await page.goto('/commande');
    await expect(page.locator('body')).toContainText(state.productName, { timeout: 8_000 });
    await page.click('button.confirm-btn');
    await page.waitForURL(/\/commande\?success=1/, { timeout: 15_000 });

    const url = new URL(page.url());
    state.orderId = url.searchParams.get('order') ?? '';
    expect(state.orderId, 'Order ID missing from redirect URL').toBeTruthy();

    const { data: item, error: itemErr } = await db
      .from('order_items')
      .select('price_ht_snapshot')
      .eq('order_id', state.orderId)
      .eq('product_id', state.productId)
      .single();
    expect(itemErr).toBeNull();
    expect(Number(item?.price_ht_snapshot), 'Ligne initiale doit être à 0€, comme le bug réel').toBe(0);
  });

  test('2. Prix du produit corrigé sur la fiche produit', async () => {
    const { error } = await db
      .from('products')
      .update({ price_ht: CORRECTED_PRICE })
      .eq('id', state.productId);
    expect(error).toBeNull();
  });

  test('3. Édition admin de la commande (quantité inchangée) et sauvegarde', async () => {
    await page.goto('/admin/login');
    await page.fill('input[name="email"]', process.env.TEST_ADMIN_EMAIL!);
    await page.fill('input[name="password"]', process.env.TEST_ADMIN_PASSWORD!);
    await page.click('button[type="submit"]');
    await page.waitForURL(/\/admin($|\/)/, { timeout: 15_000 });

    await page.goto(`/admin/commandes/${state.orderId}/edit`);
    // Aucune modification de quantité — reproduit le cas réel : l'admin
    // ouvre la commande et valide directement.
    await expect(page.locator('#submitBtn')).toBeEnabled({ timeout: 8_000 });
    await page.click('#submitBtn');
    await page.waitForURL(/\/admin\/commandes\?updated=1/, { timeout: 15_000 });
  });

  test('4. Relecture : la ligne et le total reflètent le nouveau prix', async () => {
    const { data: item, error } = await db
      .from('order_items')
      .select('price_ht_snapshot, quantity')
      .eq('order_id', state.orderId)
      .eq('product_id', state.productId)
      .single();

    expect(error).toBeNull();
    expect(
      Number(item?.price_ht_snapshot),
      'price_ht_snapshot doit refléter le prix produit corrigé après édition+sauvegarde',
    ).toBe(CORRECTED_PRICE);
    expect(item?.quantity, 'La quantité ne doit pas être affectée par le correctif').toBe(1);
  });
});
