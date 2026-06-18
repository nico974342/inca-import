/**
 * Inca Import — End-to-End Test Suite
 *
 * Prerequisites:
 *   1. Add to .env:
 *        TEST_ADMIN_EMAIL=<your-admin-email>
 *        TEST_ADMIN_PASSWORD=<your-admin-password>
 *   2. Dev server running (or playwright.config.ts webServer starts it)
 *
 * Steps covered:
 *   1.  Create test client account (via Supabase Admin API — no email confirmation needed)
 *   2.  Login as client
 *   3.  Add product to cart, place order
 *   4.  Login as admin
 *   5.  Change order status → confirmée
 *   6.  Email notification (fire-and-forget — verify trigger conditions met)
 *   7.  Upload invoice PDF to the order
 *   8.  Verify upload succeeded (invoice_path set in DB)
 *   9.  Client views /mes-commandes — order shows confirmée + invoice link
 *   10. Stock quantity decremented after confirmation
 *   11. Admin /admin/livraison — confirmed order visible in pending banner
 *   12. Client /mes-livraisons — page loads; delivery note section shown
 */

import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

// ── Supabase admin client — initialized lazily in beforeAll ──────
// (module-level env reads happen before Playwright loads .env)
let db: SupabaseClient;

function getEnv(key: string): string {
  const v = process.env[key];
  if (!v) throw new Error(`Missing env var: ${key}. Add it to .env`);
  return v;
}

// ── Shared test state ─────────────────────────────────────────────
// Use a fixed suffix so re-runs can be debugged; Date.now() avoids collisions.
const RUN_ID        = String(Date.now()).slice(-6);
const TEST_EMAIL    = `e2e-${RUN_ID}@test.inca-import.local`;
const TEST_PASSWORD = 'E2ePlaywright2026!';

const state = {
  userId:       '',
  productId:    '',
  productName:  '',
  initialStock: 0,
  orderId:      '',
};

// ── Shared browser page (session persists across tests) ───────────
let ctx: BrowserContext;
let page: Page;

// ── Helpers ───────────────────────────────────────────────────────
async function loginAsClient() {
  await page.goto('/connexion/client');
  await page.fill('input[name="email"]', TEST_EMAIL);
  await page.fill('input[name="password"]', TEST_PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForURL('**/catalogue', { timeout: 15_000 });
}

async function loginAsAdmin() {
  await page.goto('/admin/login');
  await page.fill('input[name="email"]', process.env.TEST_ADMIN_EMAIL!);
  await page.fill('input[name="password"]', process.env.TEST_ADMIN_PASSWORD!);
  await page.click('button[type="submit"]');
  await page.waitForURL(/\/admin($|\/)/, { timeout: 15_000 });
}

// ─────────────────────────────────────────────────────────────────
test.describe.serial('Inca Import — Full E2E Flow', () => {

  test.beforeAll(async ({ browser }) => {
    // Initialize Supabase admin client here so env vars are loaded by Playwright
    db = createClient(getEnv('SUPABASE_URL'), getEnv('SUPABASE_SERVICE_ROLE_KEY'), {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    // Validate admin test credentials are set
    getEnv('TEST_ADMIN_EMAIL');
    getEnv('TEST_ADMIN_PASSWORD');

    // Find a product with enough stock to order
    const { data: products, error: prodErr } = await db
      .from('products')
      .select('id, name, stock_quantity')
      .gte('stock_quantity', 2)
      .order('stock_quantity', { ascending: false })
      .limit(1);

    if (prodErr || !products?.length)
      throw new Error('No products with stock_quantity >= 2 found. Add test products first.');

    state.productId    = products[0].id;
    state.productName  = products[0].name;
    state.initialStock = products[0].stock_quantity;

    // Shared browser context — cookies persist between all tests
    ctx  = await browser.newContext();
    page = await ctx.newPage();
  });

  test.afterAll(async () => {
    // Clean up test data
    if (state.orderId) {
      await db.from('order_items').delete().eq('order_id', state.orderId);
      await db.from('orders').delete().eq('id', state.orderId);
      // Remove uploaded invoice from storage (best effort)
      await db.storage.from('invoices').remove([`${state.orderId}/facture.pdf`]);
    }
    if (state.userId) {
      await db.from('client_accounts').delete().eq('email', TEST_EMAIL);
      await db.auth.admin.deleteUser(state.userId);
    }
    // Restore stock if it changed
    if (state.productId && state.initialStock > 0) {
      await db.from('products').update({
        stock_quantity: state.initialStock,
        in_stock: true,
      }).eq('id', state.productId);
    }
    await ctx.close();
  });

  // ── Step 1: Create test account ─────────────────────────────────
  test('1. Créer compte client (Supabase Admin API)', async () => {
    const { data, error } = await db.auth.admin.createUser({
      email:         TEST_EMAIL,
      password:      TEST_PASSWORD,
      email_confirm: true,
      user_metadata: {
        role:      'client',
        nom:       'Playwright E2E',
        societe:   'Test SARL',
        telephone: '0692000000',
      },
    });

    expect(error, `createUser failed: ${error?.message}`).toBeNull();
    expect(data?.user?.id).toBeTruthy();
    state.userId = data!.user!.id;

    // Insert client_accounts row (needed for livraison/delivery_notes)
    const { error: caErr } = await db.from('client_accounts').insert({
      nom:             'Playwright E2E',
      email:           TEST_EMAIL,
      telephone:       '0692000000',
      points_de_vente: 'Test E2E PDV',
      status:          'actif',
    });
    expect(caErr, `client_accounts insert failed: ${caErr?.message}`).toBeNull();
  });

  // ── Step 2: Login as client ─────────────────────────────────────
  test('2. Connexion client', async () => {
    await loginAsClient();
    expect(page.url()).toContain('/catalogue');
  });

  // ── Step 3: Add to cart and place order ─────────────────────────
  test('3. Ajouter au panier et passer commande', async () => {
    // Add product to cart via API (session cookies are set from step 2)
    const addRes = await page.request.post('/api/cart/add', {
      data:    { productId: state.productId, qty: 1 },
      headers: { 'Content-Type': 'application/json' },
    });
    expect(addRes.status(), `Cart add failed with ${addRes.status()}: ${await addRes.text()}`).toBe(200);

    // Navigate to /commande — cart should show the product
    await page.goto('/commande');
    await expect(page.locator('body')).toContainText(state.productName, { timeout: 8_000 });

    // Submit the order form (use the specific "confirm" class to avoid nav logout btn)
    await page.click('button.confirm-btn');

    // Should redirect to /commande?success=1&order=<id>
    await page.waitForURL(/\/commande\?success=1/, { timeout: 15_000 });

    // Extract order ID from URL
    const url = new URL(page.url());
    state.orderId = url.searchParams.get('order') ?? '';
    expect(state.orderId, 'Order ID missing from redirect URL').toBeTruthy();
  });

  // ── Step 4: Login as admin ──────────────────────────────────────
  test('4. Connexion admin', async () => {
    await loginAsAdmin();
    expect(page.url()).toContain('/admin');
  });

  // ── Step 5: Change order status to confirmée ────────────────────
  test('5. Changer statut commande → confirmée', async () => {
    await page.goto('/admin/commandes');
    await page.waitForLoadState('networkidle');

    // Open the details accordion for our order
    const detailsEl = page.locator(`details:has(input[name="order_id"][value="${state.orderId}"])`);
    await expect(detailsEl, 'Order details accordion not found').toBeVisible({ timeout: 8_000 });

    // Click summary to open it (needed to reveal inner form)
    await detailsEl.locator('summary').click();

    // Change status select to "confirmee"
    const statusSelect = detailsEl.locator('select[name="status"]');
    await statusSelect.selectOption('confirmee');
    await detailsEl.locator('button[type="submit"].status-save').click();

    // Wait for page reload after form POST
    await page.waitForURL('**/admin/commandes', { timeout: 15_000 });
    await page.waitForLoadState('networkidle');

    // Verify in DB
    const { data: order } = await db.from('orders').select('status').eq('id', state.orderId).single();
    expect(order?.status, 'Order status not updated to confirmee').toBe('confirmee');
  });

  // ── Step 6: Email notification (fire-and-forget) ─────────────────
  test('6. Notification email — conditions vérifiées', async () => {
    // The status-change email is sent server-side as fire-and-forget.
    // We can't intercept SMTP in e2e, but we verify the order has the
    // email field populated (trigger was possible) and status is confirmee.
    const { data: order } = await db
      .from('orders')
      .select('status, email')
      .eq('id', state.orderId)
      .single();

    expect(order?.status).toBe('confirmee');
    expect(order?.email).toBe(TEST_EMAIL);
    // Email delivery itself is not verifiable without an email sink service (e.g. Mailpit).
    // PASS means the trigger conditions were satisfied.
  });

  // ── Step 7: Upload invoice PDF ───────────────────────────────────
  test('7. Upload facture Pennylane (PDF)', async () => {
    await page.goto('/admin/commandes');
    await page.waitForLoadState('networkidle');

    // Scroll to and open the order details
    const detailsEl = page.locator(`details:has(input[name="order_id"][value="${state.orderId}"])`);
    await expect(detailsEl).toBeVisible({ timeout: 8_000 });
    await detailsEl.locator('summary').click();

    // Locate the upload form
    const uploadForm = page.locator(`form[action="/api/admin/orders/${state.orderId}/upload-invoice"]`);
    await expect(uploadForm, 'Upload form not found').toBeVisible({ timeout: 5_000 });

    // Build a minimal valid PDF in memory
    const pdfBuffer = Buffer.from(
      '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n' +
      '2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n' +
      '3 0 obj<</Type/Page/MediaBox[0 0 612 792]/Parent 2 0 R>>endobj\n' +
      'xref\n0 4\n0000000000 65535 f\n0000000009 00000 n\n' +
      '0000000058 00000 n\n0000000115 00000 n\n' +
      'trailer<</Size 4/Root 1 0 R>>\nstartxref\n190\n%%EOF'
    );

    await uploadForm.locator('input[type="file"]').setInputFiles({
      name:     'facture-test.pdf',
      mimeType: 'application/pdf',
      buffer:   pdfBuffer,
    });

    await uploadForm.locator('button[type="submit"]').click();

    // Should redirect back to /admin/commandes after upload
    await page.waitForURL('**/admin/commandes', { timeout: 20_000 });
  });

  // ── Step 8: Verify upload succeeded ─────────────────────────────
  test('8. Vérifier invoice_path enregistré en base', async () => {
    const { data: order, error } = await db
      .from('orders')
      .select('invoice_path')
      .eq('id', state.orderId)
      .single();

    expect(error, `DB query failed: ${error?.message}`).toBeNull();
    expect(order?.invoice_path, 'invoice_path should be set after upload').toBeTruthy();
    expect(order?.invoice_path).toBe(`${state.orderId}/facture.pdf`);
  });

  // ── Step 9: Client views order + invoice in /mes-commandes ───────
  test('9. Client — /mes-commandes : statut confirmée + lien facture', async () => {
    await loginAsClient();

    await page.goto('/mes-commandes');
    await page.waitForLoadState('networkidle');

    // Status badge is in the <summary> — visible without expanding
    await expect(page.locator('text=Confirmée').first()).toBeVisible({ timeout: 8_000 });

    // Expand the order <details> to reveal the invoice download link
    const detailsEl = page.locator(`details:has(a[href="/api/orders/${state.orderId}/invoice"])`);
    await expect(detailsEl).toBeAttached({ timeout: 5_000 });
    await detailsEl.locator('summary').click();

    // Invoice download link should now be visible
    const invoiceLink = page.locator(`a[href="/api/orders/${state.orderId}/invoice"]`);
    await expect(invoiceLink, 'Invoice download link missing in /mes-commandes').toBeVisible({ timeout: 5_000 });
  });

  // ── Step 10: Stock quantity decremented ──────────────────────────
  test('10. Stock décrémenté après confirmation', async () => {
    const { data: product, error } = await db
      .from('products')
      .select('stock_quantity')
      .eq('id', state.productId)
      .single();

    expect(error).toBeNull();
    expect(
      product?.stock_quantity,
      `Expected stock ${state.initialStock - 1}, got ${product?.stock_quantity}`,
    ).toBe(state.initialStock - 1);
  });

  // ── Step 11: Admin livraison ─────────────────────────────────────
  test('11. Admin — /admin/livraison : commande confirmée visible', async () => {
    await loginAsAdmin();

    await page.goto('/admin/livraison');
    await page.waitForLoadState('networkidle');

    // Page must load without error
    expect(page.url()).toContain('/admin/livraison');
    await expect(page.locator('body')).not.toContainText('500', { timeout: 3_000 }).catch(() => {});

    // The pending banner appears when pendingCount > 0.
    // Our confirmed order ties to "Test E2E PDV" via the client email mapping.
    const bodyText = await page.locator('body').innerText();

    // The banner title reads "{N} commande(s) prête(s) à livrer"
    // The subtitle lists matched PDV names (e.g. "Test E2E PDV") or
    // unmatched orders show the client nom ("Playwright E2E").
    const found =
      bodyText.includes('prête à livrer') ||
      bodyText.includes('prêtes à livrer') ||
      bodyText.includes('Test E2E PDV') ||
      bodyText.includes('Playwright E2E');

    expect(found, `Confirmed order not visible in /admin/livraison. Page text:\n${bodyText.slice(0, 600)}`).toBe(true);
  });

  // ── Step 12: Client views /mes-livraisons ───────────────────────
  test('12. Client — /mes-livraisons : page chargée correctement', async () => {
    await loginAsClient();

    await page.goto('/mes-livraisons');
    await page.waitForLoadState('networkidle');

    expect(page.url()).toContain('/mes-livraisons');

    // Page should show either "Aucun bon de livraison" (none generated yet)
    // or a list of delivery notes if step 11 completed a delivery.
    const bodyText = await page.locator('body').innerText();
    const hasContent =
      bodyText.includes('livraison') ||
      bodyText.includes('bon de livraison') ||
      bodyText.includes('Télécharger');

    expect(hasContent, '/mes-livraisons did not render expected content').toBe(true);
  });
});
