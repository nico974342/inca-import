/** Le formulaire d'envoi et le script d'envoi RÉELS de src/pages/commande.astro, extraits tels qu'écrits dans la page (seules les expressions Astro du formulaire sont remplacées par des valeurs fixes). */
import { readFileSync } from 'node:fs';
import ts from 'typescript';

const source = () => readFileSync('src/pages/commande.astro', 'utf8').replace(/\r\n/g, '\n');

export function formulaireReel(cle: string): string {
  const s = source();
  const debut = s.indexOf('<form method="POST" id="form-envoi"');
  const fin = s.indexOf('</form>', debut) + '</form>'.length;
  if (debut < 0 || fin < debut) throw new Error('formulaire d\'envoi introuvable dans commande.astro');
  return s.slice(debut, fin).replace(/\sdisabled=\{[^}]*\}/g, '').replace(/=\{cleEnvoi\}/g, `="${cle}"`).replace(/=\{[^}]*\}/g, '="0"');
}

/** Le script d'envoi réel (dernier bloc <script> de la page), converti de TypeScript en JavaScript. */
export function scriptReel(): string {
  const s = source();
  const debut = s.lastIndexOf('<script>') + '<script>'.length;
  const fin = s.indexOf('</script>', debut);
  if (debut <= '<script>'.length || fin < debut) throw new Error('script d\'envoi introuvable dans commande.astro');
  return ts.transpileModule(s.slice(debut, fin), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
}

export const pageAvecFormulaire = (cle: string, extra = '') => `<!doctype html><html lang="fr"><head><meta charset="utf-8"></head><body>${extra}${formulaireReel(cle)}<script>${scriptReel()}</script></body></html>`;
