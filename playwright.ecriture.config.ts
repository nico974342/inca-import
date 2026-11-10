/**
 * Tests qui ÉCRIVENT (tests/ecriture/). Jamais lancés par `npm test`.
 * N'utilise PAS le fichier .env (production) : uniquement .env.test (base de test dédiée), sur un serveur dédié (port 4322).
 * Les e-mails (Resend) et les webhooks (Make) sont désactivés pour ce serveur.
 */
import { defineConfig, devices } from '@playwright/test';
import { config as loadEnv } from 'dotenv';
import { exigerBaseDeTest } from './tests/helpers/garde-ecriture';

loadEnv({ path: '.env.test', override: true });
exigerBaseDeTest();   // la configuration elle-même refuse de démarrer si la base vise la production

const PORT = 4322;
export default defineConfig({
  testDir: './tests/ecriture',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: { baseURL: `http://localhost:${PORT}`, headless: true, screenshot: 'only-on-failure', trace: 'retain-on-failure' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: `npx astro dev --port ${PORT}`,
    url: `http://localhost:${PORT}`,
    reuseExistingServer: false,   // jamais un serveur déjà lancé (qui pourrait viser la production)
    timeout: 90_000,
    env: {
      SUPABASE_URL: process.env.SUPABASE_URL!,
      SUPABASE_ANON_KEY: process.env.SUPABASE_ANON_KEY!,
      SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY!,
      RESEND_API_KEY: '', MAKE_WEBHOOK_ORDER_URL: '', MAKE_WEBHOOK_CLIENT_URL: '',
    },
  },
});
