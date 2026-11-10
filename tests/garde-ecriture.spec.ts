/**
 * Garde-fou « jamais d'écriture en production » — aucun accès réseau, aucune donnée touchée.
 *  1. La fonction de garde refuse la production sous toutes ses formes (URL, clé, site, mauvaise config).
 *  2. Les tests qui écrivent sont isolés dans tests/ecriture/, exclus de la configuration normale.
 *  3. La configuration dédiée n'utilise jamais le fichier .env de production et ne réutilise aucun serveur existant.
 */
import { test, expect } from '@playwright/test';
import { readFileSync, readdirSync } from 'node:fs';
import { raisonDeRefus, exigerBaseDeTest, refDeCle, REF_PRODUCTION } from './helpers/garde-ecriture';

const cle = (ref: string) => `x.${Buffer.from(JSON.stringify({ ref, role: 'service_role' })).toString('base64url')}.y`;
const TEST_REF = 'abcdefghijklmnopqrst';
const base = { SUPABASE_URL: `https://${TEST_REF}.supabase.co`, TEST_SUPABASE_REF: TEST_REF, SUPABASE_SERVICE_ROLE_KEY: cle(TEST_REF), SUPABASE_ANON_KEY: cle(TEST_REF) };

test.describe('Fonction de garde', () => {
  test('refuse la production : URL, sous-domaine, clé de service, clé publique, site déployé', () => {
    const prod = `https://${REF_PRODUCTION}.supabase.co`;
    const cas: Record<string, Record<string, string>> = {
      'URL de production': { SUPABASE_URL: prod },
      'URL de production + TEST_SUPABASE_REF de production': { SUPABASE_URL: prod, TEST_SUPABASE_REF: REF_PRODUCTION },
      'URL majuscules': { SUPABASE_URL: prod.toUpperCase() },
      'URL du pooler contenant la référence': { SUPABASE_URL: `https://aws-0-eu-west-1.pooler.supabase.com/${REF_PRODUCTION}` },
      'URL de test mais clé de service de production': { ...base, SUPABASE_SERVICE_ROLE_KEY: cle(REF_PRODUCTION) },
      'URL de test mais clé publique de production': { ...base, SUPABASE_ANON_KEY: cle(REF_PRODUCTION) },
      'URL de test mais TEST_URL = site de production': { ...base, TEST_URL: 'https://inca-import.re' },
      'URL de test mais TEST_URL = www': { ...base, TEST_URL: 'https://www.inca-import.re' },
      'URL de test mais TEST_URL = aperçu Vercel': { ...base, TEST_URL: 'https://inca-import-git-feat-xyz.vercel.app' },
      'URL locale mais clé de production': { SUPABASE_URL: 'http://127.0.0.1:54321', SUPABASE_SERVICE_ROLE_KEY: cle(REF_PRODUCTION) },
      'URL locale mais TEST_SUPABASE_REF de production': { SUPABASE_URL: 'http://127.0.0.1:54321', TEST_SUPABASE_REF: REF_PRODUCTION },
    };
    for (const [nom, env] of Object.entries(cas)) {
      expect(raisonDeRefus(env), nom).not.toBeNull();
      expect(() => exigerBaseDeTest(env), nom).toThrow(/REFUSÉ/);
    }
  });

  test('refuse aussi une base distante non déclarée, absente, illisible, ou un projet différent du projet de test', () => {
    expect(raisonDeRefus({})).toMatch(/absente/);
    expect(raisonDeRefus({ SUPABASE_URL: 'pas une url' })).toMatch(/illisible/);
    expect(raisonDeRefus({ SUPABASE_URL: `https://${TEST_REF}.supabase.co` })).toMatch(/TEST_SUPABASE_REF/);
    expect(raisonDeRefus({ ...base, SUPABASE_URL: 'https://zzzzzzzzzzzzzzzzzzzz.supabase.co' })).toMatch(/ne correspond pas/);
    expect(raisonDeRefus({ ...base, SUPABASE_SERVICE_ROLE_KEY: cle('autreprojet') })).toMatch(/autre projet/);
  });

  test('accepte uniquement une base locale ou le projet de test déclaré', () => {
    expect(raisonDeRefus(base)).toBeNull();
    expect(raisonDeRefus({ ...base, TEST_URL: 'http://localhost:4322' })).toBeNull();
    expect(raisonDeRefus({ SUPABASE_URL: 'http://127.0.0.1:54321' })).toBeNull();
    expect(raisonDeRefus({ SUPABASE_URL: 'http://localhost:54321' })).toBeNull();
  });

  test('lecture de la référence d\'une clé : tolère une clé invalide', () => {
    expect(refDeCle(cle(REF_PRODUCTION))).toBe(REF_PRODUCTION);
    expect(refDeCle('n\'importe quoi')).toBeNull();
    expect(refDeCle(undefined)).toBeNull();
  });
});

test.describe('Isolement des tests qui écrivent', () => {
  const lister = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap(e => e.isDirectory() ? lister(`${d}/${e.name}`) : [`${d}/${e.name}`]);
  const ECRIT = /\.from\([^)]*\)\s*\.(insert|update|upsert|delete)\(|auth\.admin\.(createUser|deleteUser|updateUserById)|\.storage\.from\([^)]*\)\.(upload|remove)\(/;

  test('aucun test hors tests/ecriture/ n\'écrit via le client Supabase', () => {
    const fautifs = lister('tests').filter(f => f.endsWith('.ts') && !f.startsWith('tests/ecriture/') && !f.startsWith('tests/helpers/') && ECRIT.test(readFileSync(f, 'utf8')));
    expect(fautifs).toEqual([]);
  });

  test('chaque test qui écrit appelle le garde-fou avant de créer son client', () => {
    const specs = lister('tests/ecriture').filter(f => f.endsWith('.spec.ts'));
    expect(specs.length).toBeGreaterThanOrEqual(2);
    for (const f of specs) {
      const src = readFileSync(f, 'utf8');
      expect(src, f).toContain('exigerBaseDeTest()');
      expect(src.indexOf('exigerBaseDeTest()'), `${f} : garde avant createClient`).toBeLessThan(src.indexOf('createClient('));
    }
  });

  test('la configuration normale ignore tests/ecriture/ ; la configuration dédiée n\'utilise ni .env de production ni serveur existant', () => {
    expect(readFileSync('playwright.config.ts', 'utf8')).toMatch(/testIgnore:\s*\[\s*'\*\*\/ecriture\/\*\*'/);
    const dediee = readFileSync('playwright.ecriture.config.ts', 'utf8');
    expect(dediee).not.toMatch(/path:\s*'\.env'/);
    expect(dediee).toContain(`path: '.env.test'`);
    expect(dediee).toContain('exigerBaseDeTest()');
    expect(dediee).toMatch(/reuseExistingServer:\s*false/);
    expect(dediee).toMatch(/RESEND_API_KEY:\s*''/);
    expect(dediee).toMatch(/MAKE_WEBHOOK_ORDER_URL:\s*''/);
  });

  test('« npm test » n\'atteint pas les tests qui écrivent ; ils ont leur propre script', () => {
    const scripts = JSON.parse(readFileSync('package.json', 'utf8')).scripts;
    expect(scripts.test).toBe('playwright test');
    expect(scripts['test:ecriture']).toContain('playwright.ecriture.config.ts');
  });
});
