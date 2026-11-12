/**
 * Recherche instantanée de l'onglet « Clients » (administration) : logique de recherche (accents, casse, téléphone, plusieurs mots) et contrôles de la page.
 * Aucune connexion, aucune écriture : fonctions pures et lecture du code source.
 */
import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { normaliser, chiffres, variantesTelephone, indexClient, correspond, libelleResultats, type ChampsRecherche } from '../src/lib/rechercheClients';

const lire = (f: string) => readFileSync(f, 'utf8').replace(/\r\n/g, '\n');
const trouve = (c: ChampsRecherche, q: string) => correspond(indexClient(c), q);

const ELODIE: ChampsRecherche = { nom: 'Élodie Ménard', societe: "Supérette de l'Étang", pointsDeVente: 'Station Total Les Tamarins', telephone: '+262 692 00 11 22', email: 'Elodie@Superette-Etang.re' };
const MARIE: ChampsRecherche = { nom: 'Marie Hoarau', societe: 'Épicerie Chez Marie', pointsDeVente: null, telephone: '0692 12 34 56', email: 'marie@epicerie-marie.re' };
const SANS_RIEN: ChampsRecherche = { nom: 'Hugo Séry', societe: null, pointsDeVente: null, telephone: null, email: null };

test.describe('Logique de recherche', () => {
  test('insensible aux majuscules, minuscules et accents', () => {
    expect(normaliser('  ÉPICERIE   Chez  Marie ')).toBe('epicerie chez marie');
    expect(normaliser('Œuf Æther Straße Ô Délices')).toBe('oeuf aether strasse o delices');
    expect(normaliser(null)).toBe(''); expect(normaliser(undefined)).toBe('');
    for (const q of ['elodie', 'ELODIE', 'Élodie', 'éLoDiE', 'menard', 'MÉNARD', 'superette', 'SUPÉRETTE', "l'etang", "L'ÉTANG", 'Etang']) expect(trouve(ELODIE, q), q).toBe(true);
    expect(trouve(MARIE, 'EPICERIE')).toBe(true); expect(trouve(MARIE, 'épicerie')).toBe(true);
  });

  test('cherche dans le nom du contact, la société, le nom du commerce (point de vente), le téléphone et l\'e-mail — et seulement là', () => {
    expect(trouve(ELODIE, 'tamarins')).toBe(true);                        // nom du commerce (point de vente)
    expect(trouve(ELODIE, 'total')).toBe(true);
    expect(trouve(ELODIE, 'superette-etang.re')).toBe(true);              // e-mail
    expect(trouve(ELODIE, '@superette')).toBe(true);
    expect(trouve(ELODIE, 'hoarau')).toBe(false); expect(trouve(MARIE, 'tamarins')).toBe(false);
    expect(trouve(SANS_RIEN, 'hugo')).toBe(true); expect(trouve(SANS_RIEN, 'sery')).toBe(true);   // champs vides : aucune erreur
    expect(trouve(SANS_RIEN, 'epicerie')).toBe(false);
  });

  test('plusieurs mots : tous doivent se retrouver, dans n\'importe quel champ et n\'importe quel ordre', () => {
    expect(trouve(ELODIE, 'menard etang')).toBe(true); expect(trouve(ELODIE, 'etang menard')).toBe(true);
    expect(trouve(ELODIE, 'elodie tamarins')).toBe(true);                // nom + commerce
    expect(trouve(ELODIE, 'elodie hoarau')).toBe(false);                 // un mot absent : refusé
    expect(trouve(MARIE, 'marie epicerie')).toBe(true);
  });

  test('téléphone : national, international, avec ou sans espaces, points, tirets, « + » ou « 00 »', () => {
    for (const q of ['0692 00 11 22', '0692001122', '06 92 00 11 22', '0692.00.11.22', '0692-00-11-22', '+262 692 00 11 22', '262692001122', '+262692001122', '00262692001122', '692 00 11', '001122', '692001']) expect(trouve(ELODIE, q), q).toBe(true);
    for (const q of ['0692 12 34 56', '262692123456', '+262 692 12 34 56', '0692123456', '12 34 56']) expect(trouve(MARIE, q), q).toBe(true);
    expect(trouve(ELODIE, '0692 12 34 56')).toBe(false); expect(trouve(MARIE, '0692 00 11 22')).toBe(false);
    expect(trouve(SANS_RIEN, '0692')).toBe(false);                        // pas de numéro : aucune correspondance, aucune erreur
    expect(trouve(ELODIE, 'elodie 0692001122')).toBe(true);                // nom + numéro collé dans la même saisie
    expect(variantesTelephone('+262 692 00 11 22').split(' ').sort()).toEqual(['0692001122', '262692001122']);
    expect(variantesTelephone('0692 12 34 56').split(' ').sort()).toEqual(['0692123456', '262692123456']);
    expect(variantesTelephone(null)).toBe(''); expect(chiffres('+262 (0)692')).toBe('2620692');
  });

  test('requête vide ou faite d\'espaces : tout correspond ; saisie étrange : jamais d\'erreur', () => {
    for (const q of ['', '   ', '\t']) { expect(trouve(ELODIE, q)).toBe(true); expect(trouve(SANS_RIEN, q)).toBe(true); }
    for (const q of ['(', '[', '\\', '*', '.*', '+', '?', '$', '^', '%', '"', "'", '<script>', 'é'.repeat(500)]) expect(() => trouve(ELODIE, q), q).not.toThrow();
    expect(trouve(ELODIE, '.*')).toBe(false);                             // le texte saisi est cherché tel quel, jamais interprété comme une expression
    expect(trouve(ELODIE, '2')).toBe(true);                               // un seul chiffre : simple recherche de texte
  });

  test('libellé du nombre de résultats', () => {
    expect(libelleResultats(0, 74)).toBe(''); expect(libelleResultats(1, 74)).toBe('1 résultat sur 74'); expect(libelleResultats(8, 74)).toBe('8 résultats sur 74');
  });

  test('rapide : 5 000 clients filtrés en moins de 100 ms', () => {
    const index = Array.from({ length: 5000 }, (_, i) => indexClient({ nom: `Client ${i} Ménard`, societe: `Société ${i % 50}`, telephone: `0692 ${String(i).padStart(6, '0')}`, email: `c${i}@exemple.re` }));
    const t = performance.now(); const n = index.filter(x => correspond(x, 'menard 4')).length; const dt = performance.now() - t;
    expect(n).toBeGreaterThan(0); expect(dt).toBeLessThan(100);
  });
});

test.describe('Page /admin/clients', () => {
  const page = lire('src/pages/admin/clients.astro');

  test('barre de recherche : champ de recherche, message « Aucun client trouvé », compteur, bouton d\'effacement, étiquette pour les lecteurs d\'écran', () => {
    expect(page).toContain('id="clients-recherche"'); expect(page).toContain('type="search"'); expect(page).toContain('data-testid="clients-recherche"');
    expect(page).toContain('Aucun client trouvé.'); expect(page).toContain('id="clients-aucun"'); expect(page).toContain('data-testid="clients-aucun"');
    expect(page).toContain('id="clients-recherche-compteur"'); expect(page).toContain('aria-live="polite"'); expect(page).toContain('aria-label="Effacer la recherche"');
    expect(page).toContain('<label for="clients-recherche" class="sr-only">Rechercher un client</label>');
    expect(page).toContain('placeholder="Nom, société, téléphone ou e-mail…"');
  });

  test('instantanée et sans rechargement : toutes les lignes de la vue sont dans la page, chacune avec son index ; le filtrage se fait au fil de la saisie', () => {
    expect(page).toContain('{rows.map(r => ('); expect(page).not.toContain('{pageRows.map(r => (');
    expect(page).toContain('data-recherche={indexClient(r).texte}'); expect(page).toContain('data-tel={indexClient(r).tel}');
    expect(page).toContain("data-page-courante={surLaPage.has(`${r.kind}:${r.id}`) ? '1' : '0'}"); expect(page).toContain('hidden={!surLaPage.has(`${r.kind}:${r.id}`)}');
    expect(page).toContain("champ.addEventListener('input', () => appliquerRecherche(champ.value))");
    expect(page).toContain("import { correspond, libelleResultats } from '../../lib/rechercheClients';"); expect(page).toContain("import { indexClient } from '../../lib/rechercheClients';");
  });

  test('avec les filtres existants : onglets et pagination inchangés, la recherche porte sur la vue affichée et se transmet aux liens (paramètre q)', () => {
    expect(page).toContain("const filterView = Astro.url.searchParams.get('view') ?? '';");
    expect(page).toContain("const rows = filterView\n  ? allRows.filter(r => (filterView === 'contact' ? r.kind === 'contact' : r.kind === 'client' && r.status === filterView))\n  : allRows;");
    expect(page).toContain("document.querySelectorAll<HTMLAnchorElement>('a.filter-tab, a.page-btn')"); expect(page).toContain("url.searchParams.set('q'");
    expect(page).toContain("if (actif) u.searchParams.set('q', valeur.trim()); else u.searchParams.delete('q');"); expect(page).toContain('a.href = u.pathname + u.search;');   // les onglets et la pagination gardent la recherche
    expect(page).toContain('if (pagination) pagination.hidden = actif;'); expect(page).toContain('.pagination[hidden], .empty-state[hidden], .table-wrap[hidden] { display: none !important; }');
  });

  test('rien d\'autre ne change : fiches, actions, formulaires, permissions et données', () => {
    for (const a of ['create_client', 'update_client', 'update_contact_notes', 'convert', 'activate_client']) expect(page, a).toContain(`value="${a}"`);
    expect(page).toContain("data-href={r.kind === 'client' ? `/admin/clients/${r.id}` : undefined}");
    expect(page).toContain('const viewerIsAdmin = isAdmin((Astro.locals as any).user);');
    expect(page).toContain('const PAGE_SIZE = 30;');                                                  // la pagination (sans recherche) est celle d'avant
    const script = page.slice(page.indexOf('<script>'), page.indexOf('</script>'));
    expect(script).not.toMatch(/fetch\(|XMLHttpRequest|sendBeacon|localStorage|sessionStorage|document\.cookie/);   // la recherche n'envoie ni ne stocke rien
    const lib = lire('src/lib/rechercheClients.ts'); expect(lib).not.toMatch(/supabase|fetch\(|import\s/);   // fonctions pures : aucune lecture, aucune écriture
  });

  test('téléphone : champ de 44 px de haut, taille de texte lisible, une seule croix d\'effacement', () => {
    expect(page).toContain('min-height: 44px'); expect(page).toContain('font-size: 1rem');
    expect(page).toContain('::-webkit-search-cancel-button'); expect(page).toContain('padding-left: 2.5rem');
    expect(page).toContain('.clients-recherche-champ .clients-recherche-input');                      // l'icône ne chevauche pas le texte saisi
  });

  test('la recherche n\'expose que ce que le tableau affiche déjà : l\'index est fait des cinq champs visibles', () => {
    const lib = lire('src/lib/rechercheClients.ts');
    expect(lib).toContain('[c.nom, c.societe, c.pointsDeVente, c.telephone, c.email]');
    for (const col of ['<th>Nom</th>', '<th>Société</th>', '<th>Téléphone</th>', '<th>Email</th>', '<th>Point de vente</th>']) expect(page, col).toContain(col);
  });
});
