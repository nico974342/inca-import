/**
 * Envoi de la commande du client dans un VRAI navigateur (Chromium), avec le formulaire et le script réels de src/pages/commande.astro. Aucune connexion distante :
 * toutes les requêtes sont interceptées. Ce test aurait détecté l'incident du 12 au 18 novembre 2026 : le champ caché name="action" du formulaire masque
 * form.action (qui valait « [object HTMLInputElement] »), l'envoi partait vers une adresse inexistante, aucune commande ne pouvait être enregistrée.
 */
import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

const source = readFileSync('src/pages/commande.astro', 'utf8').replace(/\r\n/g, '\n');

/** Le formulaire d'envoi tel qu'il est écrit dans la page (les seules expressions Astro sont remplacées par des valeurs fixes). */
function formulaireReel(): string {
  const debut = source.indexOf('<form method="POST" id="form-envoi"');
  const fin = source.indexOf('</form>', debut) + '</form>'.length;
  expect(debut).toBeGreaterThan(0);
  return source.slice(debut, fin).replace(/\sdisabled=\{[^}]*\}/g, '').replace(/=\{cleEnvoi\}/g, '="3ccbeab0-ff21-4703-8c2c-9d9d39f03ba6"').replace(/=\{[^}]*\}/g, '="0"');
}
/** Le script d'envoi réel (le dernier bloc <script> de la page), converti de TypeScript en JavaScript. */
function scriptReel(): string {
  const debut = source.lastIndexOf('<script>') + '<script>'.length;
  const fin = source.indexOf('</script>', debut);
  expect(debut).toBeGreaterThan('<script>'.length);
  return ts.transpileModule(source.slice(debut, fin), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
}

const PAGE = 'http://localhost:4321/commande';

test.describe('Envoi de la commande (navigateur réel)', () => {
  test('le formulaire contient bien un champ « action » (c\'est ce qui masque form.action) : l\'envoi doit viser l\'adresse de la page, jamais form.action', async ({ page }) => {
    expect(formulaireReel()).toContain('name="action"');
    const code = scriptReel();
    expect(code.replace(/\/\/.*$/gm, '')).not.toMatch(/form\.action/);      // hors commentaires
  });

  test('un clic sur « Envoyer ma commande » envoie le formulaire en POST vers /commande (champs action, cle, notes), et affiche la réponse du serveur', async ({ page }) => {
    const posts: { url: string; method: string; corps: string }[] = [];
    const statuts: string[] = [];
    await page.route('**/*', async route => {
      const req = route.request(); const url = req.url();
      if (url === PAGE && req.method() === 'GET' && posts.length > 0) return route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><html><body><p id="reponse">commande reçue</p></body></html>' });      // le serveur a répondu : page de succès
      if (url === PAGE && req.method() === 'GET') return route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: `<!doctype html><html><body>${formulaireReel()}<script>${scriptReel()}</script></body></html>` });
      if (req.method() === 'POST') { posts.push({ url, method: req.method(), corps: req.postData() ?? '' }); return route.fulfill({ status: 200, contentType: 'text/html', body: 'ok' }); }
      if (url.includes('/api/commande/statut')) { statuts.push(url); return route.fulfill({ status: 200, contentType: 'application/json', body: '{"enregistree":false}' }); }
      return route.fulfill({ status: 404, body: 'introuvable' });
    });
    await page.goto(PAGE);
    await page.getByTestId('envoyer').click();
    await expect(page.locator('#reponse')).toBeVisible();

    expect(posts).toHaveLength(1);
    expect(posts[0].url).toBe(PAGE);                                   // et non « …/[object HTMLInputElement] »
    expect(posts[0].corps).toContain('name="action"');
    expect(posts[0].corps).toContain('envoyer');
    expect(posts[0].corps).toContain('3ccbeab0-ff21-4703-8c2c-9d9d39f03ba6');
    expect(statuts).toHaveLength(0);                                   // aucun « vérification de la commande » : l'envoi a abouti
  });

  test('une vraie coupure reste gérée : le serveur est interrogé, la commande est dite « non enregistrée », le bouton se rouvre et la même clé est conservée', async ({ page }) => {
    const statuts: string[] = [];
    await page.route('**/*', async route => {
      const req = route.request(); const url = req.url();
      if (url === PAGE && req.method() === 'GET') return route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: `<!doctype html><html><body>${formulaireReel()}<script>${scriptReel()}</script></body></html>` });
      if (req.method() === 'POST') return route.abort('connectionfailed');
      if (url.includes('/api/commande/statut')) { statuts.push(url); return route.fulfill({ status: 200, contentType: 'application/json', body: '{"enregistree":false}' }); }
      return route.fulfill({ status: 404, body: 'introuvable' });
    });
    await page.goto(PAGE);
    await page.getByTestId('envoyer').click();
    await expect(page.locator('#envoi-etat')).toContainText('n\'a pas été enregistrée');
    await expect(page.getByTestId('envoyer')).toBeEnabled();
    expect(statuts).toHaveLength(1);
    expect(statuts[0]).toContain('cle=3ccbeab0-ff21-4703-8c2c-9d9d39f03ba6');
  });
});
