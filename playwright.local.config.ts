/**
 * Tests 100 % LOCAUX : bases PGlite en mémoire, vérifications du code source, fonctions pures.
 *
 * - Ne charge PAS le fichier .env (production) et ne lance AUCUN serveur : aucune clé n'est lue, aucun port n'est ouvert.
 * - Les variables Supabase sont forcées sur une adresse locale injoignable (127.0.0.1:9) ; les clés Resend / Make sont supprimées.
 * - ARRÊT EXPLICITE (et non une connexion silencieuse) si l'environnement du shell contient déjà une adresse Supabase non locale, ou si l'adresse
 *   de test (TEST_URL) n'est pas locale : la configuration refuse de démarrer.
 * - Les tests qui écrivent (tests/ecriture/) et les tests privés restent exclus ; ils ont leur propre configuration et leur propre garde-fou.
 *
 * Usage : npm run test:local   (ou : npx playwright test -c playwright.local.config.ts [fichiers…])
 */
import { defineConfig, devices } from '@playwright/test';

const LOCAL = /^(localhost|127\.0\.0\.1|\[::1\])$/i;
const estLocale = (valeur: string | undefined): boolean => {
  if (!valeur) return true;                                   // absente : rien à craindre
  try { return LOCAL.test(new URL(valeur).hostname); } catch { return false; }   // illisible : refusée
};
for (const nom of ['SUPABASE_URL', 'TEST_URL']) {
  if (!estLocale(process.env[nom])) {
    throw new Error(`playwright.local.config.ts : ${nom} ne vise pas une adresse locale. Les tests locaux ne se connectent jamais à une base distante : retirez cette variable de votre environnement.`);
  }
}

process.env.SUPABASE_URL = 'http://127.0.0.1:9';
process.env.SUPABASE_ANON_KEY = 'local-sans-valeur';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'local-sans-valeur';
delete process.env.RESEND_API_KEY;
delete process.env.MAKE_WEBHOOK_ORDER_URL;
delete process.env.TEST_ADMIN_EMAIL;
delete process.env.TEST_ADMIN_PASSWORD;

export default defineConfig({
  testDir: './tests',
  // signature-tactile pilote une vraie page et exige un serveur ; e2e et order-edit-price-snapshot visent un serveur ; private = hors suite
  testIgnore: ['**/ecriture/**', '**/private/**', '**/signature-tactile.spec.ts', '**/e2e.spec.ts', '**/order-edit-price-snapshot.spec.ts'],
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: { headless: true },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
