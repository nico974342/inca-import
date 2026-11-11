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
const IDS = ['ventes', 'achats', 'stocks', 'commercial', 'gestion'];   // ordre demandé : Ventes, Achats, Stocks, Commercial, Gestion

test.describe('Menu repliable', () => {
  test('un seul menu (composant existant) ; cinq rubriques : Ventes, Achats, Stocks, Commercial, Gestion', () => {
    expect(layout.match(/<nav class="sidebar-nav"/g)).toHaveLength(1);
    expect(layout.match(/<nav\b/g)).toHaveLength(1);
    expect([...layout.matchAll(/<div class="nav-groupe" data-groupe="(\w+)"/g)].map(m => m[1])).toEqual(IDS);
    expect([...layout.matchAll(/<span class="nav-groupe-label">([^<]+)<\/span>/g)].map(m => m[1])).toEqual(['Ventes', 'Achats', 'Stocks', 'Commercial', 'Gestion']);
    expect(layout).not.toMatch(/Achats et stock/);
  });

  test('accessibilité : un vrai bouton par rubrique dans un titre, aria-expanded et aria-controls reliés au sous-menu, sous-menu fermé masqué', () => {
    for (const id of IDS) {
      expect(layout).toContain(`<button type="button" class="nav-groupe-btn" id="nav-btn-${id}" aria-expanded={groupeActif === '${id}' ? 'true' : 'false'} aria-controls="nav-sous-${id}">`);
      expect(layout).toContain(`<div class="nav-sous" id="nav-sous-${id}" role="group" aria-labelledby="nav-btn-${id}" hidden={groupeActif !== '${id}'}>`);
    }
    expect(layout.match(/<h2 class="nav-groupe-titre">/g)).toHaveLength(5);
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
    expect(layout).toMatch(/<script is:inline define:vars=\{\{ courant: groupeActif \}\}>[\s\S]*try \{[\s\S]*\} catch \(e\)/);                         // lecture protégée avant affichage
    expect(script).toMatch(/function lire[\s\S]*try \{[\s\S]*\} catch/);                                  // lecture protégée
    expect(script).toMatch(/function ecrire[\s\S]*try \{[\s\S]*\} catch/);                                // écriture protégée
    expect(layout).toMatch(/\/\^\[a-z\]\{3,12\}\$\/\.test\(x\)/);                                         // l'amorce n'accepte que des identifiants simples (rien d'injectable dans l'attribut)
    expect(script).toContain('m.ouverts.includes(id) || (!m.connus.includes(id) && defaut.includes(id))');   // choix mémorisé prioritaire ; rubrique jamais vue (ajoutée depuis) : état par défaut
    expect(script).toContain('RUBRIQUES_D_ORIGINE');                                                      // ancien format de mémoire encore lu
    expect(layout).toContain('define:vars={{ courant: groupeActif }}');                                   // l'amorce avant affichage connaît la rubrique courante
    expect(script.match(/ecrire\(/g)).toHaveLength(2);                                                   // la définition + UN seul appel : dans le gestionnaire de clic, jamais au chargement
    expect(script.slice(script.indexOf("addEventListener('click'"))).toContain('ecrire(ouverts, tous)');
  });

  test('aucune animation de mise en page (hauteur, marges) : seulement la rotation de la flèche', () => {
    const css = layout.slice(layout.indexOf('/* Rubriques repliables'), layout.indexOf('.nav-badge'));
    expect(css).not.toMatch(/transition:[^;]*\b(height|max-height|margin|padding|width)\b/);
    expect(css).toMatch(/\.nav-chevron \{[^}]*transition: transform/);
  });

  test('les rubriques réservées à l\'administrateur le sont entièrement (titre compris) et le menu n\'ajoute aucune donnée ni appel serveur', () => {
    for (const id of ['achats', 'gestion']) expect(layout).toMatch(new RegExp(`\\{viewerIsAdmin && \\(\\n\\s+<div class="nav-groupe" data-groupe="${id}"`));
    for (const id of ['ventes', 'stocks', 'commercial']) expect(layout).not.toMatch(new RegExp(`viewerIsAdmin && \\(\\n\\s+<div class="nav-groupe" data-groupe="${id}"`));
    expect(script).not.toMatch(/fetch\(|XMLHttpRequest|supabase|document\.cookie/);
  });
});

test.describe('Rubrique Commercial', () => {
  const bloc = (id: string) => { const d = layout.indexOf(`<div class="nav-groupe" data-groupe="${id}"`); const f = layout.indexOf('<div class="nav-groupe"', d + 10); return layout.slice(d, f > 0 ? f : layout.indexOf('</nav>')).replace(/\n\s*\{viewerIsAdmin && \(\s*$/, ''); };   // sans la garde de la rubrique SUIVANTE
  const hrefs = (b: string) => [...b.matchAll(/<a href="([^"]+)" class=\{`nav-link/g)].map(m => m[1]);

  test('Aujourd\'hui, Portefeuilles, Activités sont dans Commercial (dans cet ordre), retirés de Ventes, sans aucun doublon', () => {
    expect(hrefs(bloc('commercial'))).toEqual(['/admin/aujourdhui', '/admin/portefeuilles', '/admin/activites']);
    expect(hrefs(bloc('ventes'))).toEqual(['/admin/clients', '/admin/tarifs', '/admin/commande-rapide', '/admin/preparation', '/admin/commandes', '/admin/livraison']);   // Clients et Commandes restent dans Ventes
    const tous = hrefs(layout.slice(layout.indexOf('<nav class="sidebar-nav">'), layout.indexOf('</nav>')));
    expect(new Set(tous).size).toBe(tous.length);                                                          // chaque lien une seule fois
    expect(tous).toHaveLength(18);                                                                          // aucun lien perdu ni ajouté
    expect([...layout.matchAll(/<div class="nav-groupe" data-groupe="(\w+)"/g)].map(m => m[1])).toEqual(IDS);   // Commercial entre Stocks et Gestion
  });

  test('permissions inchangées : la rubrique est visible de tout le personnel ; Activités reste réservé à l\'administrateur, lien par lien', () => {
    const b = bloc('commercial');
    expect(b).toMatch(/\{viewerIsAdmin && \(\n\s+<a href="\/admin\/activites"/);                              // la garde administrateur suit le lien
    expect(b.match(/viewerIsAdmin/g)).toHaveLength(1);                                                      // et elle ne couvre que ce lien
    expect(b).not.toMatch(/viewerIsStaff/);                                                                 // Aujourd'hui et Portefeuilles : tout le personnel, comme avant
    expect(b.indexOf('/admin/aujourdhui')).toBeLessThan(b.indexOf('viewerIsAdmin'));                        // Aujourd'hui et Portefeuilles ne sont pas sous la garde
    expect(b.indexOf('/admin/portefeuilles')).toBeLessThan(b.indexOf('viewerIsAdmin'));
  });

  test('la page courante ouvre la bonne rubrique : Aujourd\'hui, Portefeuilles et Activités → Commercial ; Clients et Commandes → Ventes', () => {
    const rubriques = layout.match(/const RUBRIQUES[\s\S]*?\n\};/)![0];
    expect(rubriques).toMatch(/commercial: \['aujourdhui', 'portefeuilles', 'activites'\]/);
    expect(rubriques).toMatch(/ventes: \['clients', 'tarifs', 'commande-rapide', 'preparation', 'commandes', 'livraison'\]/);
    expect(rubriques).not.toMatch(/ventes: [^\]]*'(aujourdhui|portefeuilles|activites)'/);
  });

  test('une rubrique ajoutée après un choix mémorisé n\'a jamais été « décidée » : elle suit l\'état par défaut (ancien et nouveau formats de mémoire)', () => {
    // même règle dans le script du menu et dans l'amorce avant affichage
    expect(layout).toMatch(/c\.indexOf\(courant\) < 0 && l\.indexOf\(courant\) < 0\) l\.push\(courant\)/);
    expect(script).toContain('!m.connus.includes(id) && defaut.includes(id)');
    expect(layout).toContain("c = ['ventes', 'achats', 'stocks', 'gestion']");                              // ancien format : les quatre rubriques d'origine
    expect(script).toContain("const RUBRIQUES_D_ORIGINE = ['ventes', 'achats', 'stocks', 'gestion']");
  });
});
