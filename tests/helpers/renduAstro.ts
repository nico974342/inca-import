/**
 * Rendu RÉEL d'un composant Astro pour les tests de navigateur : Vite (config Astro du dépôt) charge le composant, le conteneur Astro produit son HTML, et le CSS réel (global + composant + enfants)
 * est assemblé dans une page autonome que Chromium affiche. Aucune base, aucun réseau, aucun secret : le composant ne reçoit que des données de test.
 */
import { getViteConfig } from 'astro/config';
import { createServer, type ViteDevServer } from 'vite';

let serveur: Promise<ViteDevServer> | null = null;
const demarrer = (): Promise<ViteDevServer> => (serveur ??= (async () => {
  const cfg = await getViteConfig({ root: process.cwd() })({ command: 'serve', mode: 'development' });
  return createServer({ ...cfg, server: { middlewareMode: true }, appType: 'custom', logLevel: 'error' });
})());

export async function arreter(): Promise<void> { if (serveur) { const s = await serveur; await s.close(); serveur = null; } }

const css = async (s: ViteDevServer, chemin: string, index = 0): Promise<string> => {
  const r = await s.transformRequest(`${chemin}?astro&type=style&index=${index}&lang.css&direct`).catch(() => null);
  return r?.code ?? '';
};

/** Rend `composant` avec `props` et renvoie une page HTML complète (CSS inclus) ; `enfants` = composants dont le CSS doit aussi être chargé. */
export async function rendrePage(composant: string, props: Record<string, unknown>, enfants: string[] = []): Promise<string> {
  const s = await demarrer();
  const { experimental_AstroContainer: AstroContainer } = await import('astro/container');
  const mod = await s.ssrLoadModule(composant);
  const conteneur = await AstroContainer.create();
  const html = await conteneur.renderToString(mod.default, { props });
  const global = (await s.transformRequest('/src/styles/global.css?direct'))?.code ?? '';
  const styles = [global, await css(s, composant), ...(await Promise.all(enfants.map(e => css(s, e))))].join('\n');
  return `<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${styles}</style></head><body><main style="padding:16px">${html}</main></body></html>`;
}
