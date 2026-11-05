/**
 * Garde-fou : un test qui ÉCRIT dans Supabase ne peut s'exécuter que contre une base de test dédiée.
 * Refus automatique si l'URL, la clé de service ou l'adresse du site visent la production,
 * même si la configuration est fausse (mauvais .env, mauvais fichier de test, mauvais script).
 *
 * Autorisé uniquement :
 *   - une base locale (localhost / 127.0.0.1 / [::1]), ou
 *   - le projet Supabase dont la référence est déclarée dans TEST_SUPABASE_REF (jamais la référence de production).
 */
export const REF_PRODUCTION = 'uixmsrrprgvoejsuuaat';
const HOTES_PRODUCTION = ['inca-import.re'];
const HOTES_LOCAUX = ['localhost', '127.0.0.1', '[::1]', '::1'];

type Env = Record<string, string | undefined>;

/** Lit le champ « ref » d'une clé Supabase (JWT) sans la valider : sert uniquement à repérer la production. */
export function refDeCle(cle: string | undefined): string | null {
  try {
    const charge = cle?.split('.')[1];
    if (!charge) return null;
    const json = JSON.parse(Buffer.from(charge.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
    return typeof json.ref === 'string' ? json.ref : null;
  } catch { return null; }
}

const vise = (valeur: string | undefined, hote: string) => {
  if (!valeur) return false;
  try { const h = new URL(valeur).hostname.toLowerCase(); return h === hote || h.endsWith('.' + hote); }
  catch { return valeur.toLowerCase().includes(hote); }
};

/** Renvoie la raison du refus, ou null si la base est bien une base de test. */
export function raisonDeRefus(env: Env = process.env): string | null {
  const url = env.SUPABASE_URL;
  if (!url) return 'SUPABASE_URL est absente : aucune base de test configurée.';
  let hote: string;
  try { hote = new URL(url).hostname.toLowerCase(); } catch { return 'SUPABASE_URL est illisible.'; }

  // 1. Tout ce qui ressemble à la production est refusé, où que ce soit.
  const ref = REF_PRODUCTION.toLowerCase();
  for (const [nom, valeur] of Object.entries(env)) {
    if (/^(SUPABASE_|DATABASE_|POSTGRES_|TEST_URL$|TEST_SUPABASE_)/.test(nom) && valeur && nom !== 'SUPABASE_ANON_KEY' && nom !== 'SUPABASE_SERVICE_ROLE_KEY' && valeur.toLowerCase().includes(ref))
      return `${nom} désigne la base de PRODUCTION (${REF_PRODUCTION}).`;
  }
  for (const nom of ['SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY'] as const)
    if (refDeCle(env[nom]) === REF_PRODUCTION) return `${nom} est une clé de la base de PRODUCTION.`;
  for (const nom of ['TEST_URL', 'SUPABASE_URL', 'SITE_URL'])
    if (HOTES_PRODUCTION.some(h => vise(env[nom], h))) return `${nom} désigne le site de PRODUCTION.`;
  if (env.TEST_URL && !HOTES_LOCAUX.includes(new URL(env.TEST_URL).hostname)) return 'TEST_URL doit être un site local : les tests d\'écriture ne visent jamais un site déployé (aperçu ou production).';

  // 2. Liste blanche : base locale, ou projet de test explicitement déclaré.
  if (HOTES_LOCAUX.includes(hote)) return null;
  const refTest = env.TEST_SUPABASE_REF?.trim().toLowerCase();
  if (!refTest) return 'Base distante sans TEST_SUPABASE_REF : déclarez la référence de VOTRE projet de test pour l\'autoriser.';
  if (refTest === ref) return 'TEST_SUPABASE_REF est la référence de production.';
  if (hote !== `${refTest}.supabase.co`) return `SUPABASE_URL (${hote}) ne correspond pas au projet de test déclaré (${refTest}).`;
  for (const nom of ['SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY'] as const) {
    const r = refDeCle(env[nom]);
    if (r && r !== refTest) return `${nom} appartient à un autre projet (${r}) que le projet de test (${refTest}).`;
  }
  return null;
}

/** À appeler AVANT toute création de client Supabase ou toute écriture dans un test. */
export function exigerBaseDeTest(env: Env = process.env): void {
  const raison = raisonDeRefus(env);
  if (raison) throw new Error(`TEST D'ÉCRITURE REFUSÉ — ${raison} Aucune donnée n'a été touchée. Voir .env.test.example.`);
}
