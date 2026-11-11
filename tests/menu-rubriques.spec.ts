/**
 * Menu d'administration à rubriques repliables : structure et garde-fous (tests hors ligne sur le code).
 * Le comportement dans un navigateur (clic, clavier, mémoire, téléphone) a été vérifié séparément avec le vrai menu.
 * Les liens, leurs permissions et leur ordre sont comparés à la version d'avant dans suivi-achats-phase1.spec.ts.
 */
import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';

const lire = (f: string) => readFileSync(f, 'utf8').replace(/\r\n/g, '\n');
const layout = lire('src/components/admin/AdminLayout.astro');
const script = lire('src/scripts/menuRubriques.ts');
const IDS = ['ventes', 'stocks', 'achats', 'gestion'];

test.describe('Menu repliable', () => {
  test('un seul menu (composant existant) ; quatre rubriques : Ventes, Stocks, Achats, Gestion', () => {
    expect(layout.match(/<nav class="sidebar-nav"/g)).toHaveLength(1);
    expect(layout.match(/<nav\b/g)).toHaveLength(1);
    expect([...layout.matchAll(/<div class="nav-groupe" data-groupe="(\w+)"/g)].map(m => m[1])).toEqual(IDS);
    expect([...layout.matchAll(/<span class="nav-groupe-label">([^<]+)<\/span>/g)].map(m => m[1])).toEqual(['Ventes', 'Stocks', 'Achats', 'Gestion']);
    expect(layout).not.toMatch(/Achats et stock/);
  });

  test('accessibilité : un vrai bouton par rubrique dans un titre, aria-expanded et aria-controls reliés au sous-menu, sous-menu fermé masqué', () => {
    for (const id of IDS) {
      expect(layout).toContain(`<button type="button" class="nav-groupe-btn" id="nav-btn-${id}" aria-expanded={groupeActif === '${id}' ? 'true' : 'false'} aria-controls="nav-sous-${id}">`);
      expect(layout).toContain(`<div class="nav-sous" id="nav-sous-${id}" role="group" aria-labelledby="nav-btn-${id}" hidden={groupeActif !== '${id}'}>`);
    }
    expect(layout.match(/<h2 class="nav-groupe-titre">/g)).toHaveLength(4);
    expect(layout).toMatch(/<svg class="nav-chevron"[^>]*aria-hidden="true"[^>]*focusable="false"/);       // la flèche est décorative pour les lecteurs d'écran
    expect(layout).toMatch(/\.nav-groupe-btn:focus-visible \{ outline: 2px solid/);                          // anneau de focus visible
    expect(layout).toMatch(/\.nav-groupe-btn \{[^}]*min-height: 44px/);                                      // cible tactile suffisante
    expect(layout).toMatch(/\.nav-sous\[hidden\] \{ display: none; \}/);                                    // l'attribut hidden l'emporte sur le style d'affichage
    expect(layout).toMatch(/prefers-reduced-motion: reduce/);
  });

  test('par défaut : seule la rubrique de la page courante est dépliée ; chaque page du menu appartient à UNE rubrique', () => {
    const rubriques = layout.match(/const RUBRIQUES[\s\S]*?\n\};/)![0];
    const parRubrique = Object.fromEntries(IDS.map(id => [id, [...(rubriques.match(new RegExp(`${id}: \\[([^\\]]*)\\]`))![1].matchAll(/'([^']+)'/g))].map(m => m[1])]));
    const attendues = [...layout.matchAll(/<a href="\/admin\/[^"]*" class=\{`nav-link \$\{activeNav === '([\w-]+)'/g)].map(m => m[1]).filter(n => n !== 'dashboard');
    for (const nav of attendues) expect(IDS.filter(id => parRubrique[id].includes(nav)), nav).toHaveLength(1);
    expect(layout).toContain("data-courant={groupeActif === 'ventes' ? 'true' : 'false'}");
    expect(layout).toMatch(/const groupeActif = .*\?\? null;/);
    // chaque lien se trouve dans la rubrique qui le déclare
    for (const id of IDS) {
      const bloc = layout.slice(layout.indexOf(`data-groupe="${id}"`), layout.indexOf('</nav>'));
      const fin = bloc.indexOf('<div class="nav-groupe"', 10); const corps = fin > 0 ? bloc.slice(0, fin) : bloc;
      for (const nav of attendues.filter(n => parRubrique[id].includes(n))) expect(corps, `${id}/${nav}`).toContain(`activeNav === '${nav}'`);
    }
  });

  test('mémoire : même clé avant affichage et dans le script ; liste des rubriques ouvertes ; stockage indisponible toléré', () => {
    expect(layout).toContain("localStorage.getItem('inca_admin_menu_ouverts')");
    expect(script).toContain("const CLE = 'inca_admin_menu_ouverts'");
    expect(layout).toMatch(/<script is:inline>[\s\S]*try \{[\s\S]*\} catch \(e\)/);                         // lecture protégée avant affichage
    expect(script).toMatch(/function lire[\s\S]*try \{[\s\S]*\} catch/);                                  // lecture protégée
    expect(script).toMatch(/function ecrire[\s\S]*try \{[\s\S]*\} catch/);                                // écriture protégée
    expect(layout).toMatch(/\/\^\[a-z\]\{3,12\}\$\/\.test\(x\)/);                                         // l'amorce n'accepte que des identifiants simples (rien d'injectable dans l'attribut)
    expect(script).toContain('lire() ?? defaut');                                                         // choix mémorisé prioritaire, sinon rubrique courante
    expect(script).toMatch(/ecrire\(ouverts\)/);
    expect(script.match(/ecrire\(/g)).toHaveLength(2);                                                   // la définition + UN seul appel : dans le gestionnaire de clic, jamais au chargement
    expect(script.slice(script.indexOf("addEventListener('click'"))).toContain('ecrire(ouverts)');
  });

  test('aucune animation de mise en page (hauteur, marges) : seulement la rotation de la flèche', () => {
    const css = layout.slice(layout.indexOf('/* Rubriques repliables'), layout.indexOf('.nav-badge'));
    expect(css).not.toMatch(/transition:[^;]*\b(height|max-height|margin|padding|width)\b/);
    expect(css).toMatch(/\.nav-chevron \{[^}]*transition: transform/);
  });

  test('les rubriques réservées à l\'administrateur le sont entièrement (titre compris) et le menu n\'ajoute aucune donnée ni appel serveur', () => {
    for (const id of ['achats', 'gestion']) expect(layout).toMatch(new RegExp(`\\{viewerIsAdmin && \\(\\n\\s+<div class="nav-groupe" data-groupe="${id}"`));
    for (const id of ['ventes', 'stocks']) expect(layout).not.toMatch(new RegExp(`viewerIsAdmin && \\(\\n\\s+<div class="nav-groupe" data-groupe="${id}"`));
    expect(script).not.toMatch(/fetch\(|XMLHttpRequest|supabase|document\.cookie/);
  });
});
