/**
 * Ordre d'affichage du catalogue client — règles pures + contrôles de code. Aucun accès réseau ni base.
 */
import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { ordonnerCatalogue, type ProduitTri } from '../src/lib/ordreCatalogue';
import { NOUVEAU_DUREE_JOURS, CATALOGUE_ORDRE_CATEGORIES } from '../src/lib/constants';

const p = (id: string, name: string, category: string | null): ProduitTri => ({ id, name, category });
const catalogue: ProduitTri[] = [
  p('d1', 'Divers A', 'divers'), p('c1', 'Chips Paprika', 'chips'), p('b1', 'Cola', 'boissons'),
  p('b2', 'Jus', 'boissons'), p('b3', 'Eau', 'boissons'), p('s1', 'Barre', 'snacks'),
  p('k1', 'Bonbon', 'confiseries'), p('b4', 'Soda épuisé', 'boissons'), p('c2', 'Chips Nature épuisé', 'chips'),
  p('n1', 'Nouveau snack', 'snacks'), p('n2', 'Nouvelle boisson', 'boissons'),
];
const ventes = new Map([['b1', 50], ['b2', 20], ['c1', 5], ['s1', 7], ['k1', 3], ['n1', 1], ['b4', 99], ['n2', 10]]);
const indispos = new Set(['b4', 'c2']);
const nouveaux = new Set(['n1', 'n2']);
const ctx = { ventes, estDisponible: (id: string) => !indispos.has(id), estNouveau: (id: string) => nouveaux.has(id) };
const idsTous = (o = ordonnerCatalogue(catalogue, ctx)) => o.sections.flatMap(s => s.ids);
const trier = (rang: Map<string, number>, ids: string[]) => [...ids].sort((a, b) => rang.get(a)! - rang.get(b)!);

test.describe('Vue « Tous »', () => {
  const o = ordonnerCatalogue(catalogue, ctx);
  test('nouveautés d\'abord (les plus vendues en tête), puis catégories dans l\'ordre métier, indisponibles à la fin', () => {
    expect(o.sections.map(s => s.cle)).toEqual(['nouveautes', 'boissons', 'snacks', 'chips', 'confiseries', 'divers', 'indisponibles']);
    expect(o.sections[0].ids).toEqual(['n2', 'n1']);
  });
  test('dans une catégorie : plus vendus d\'abord ; sans historique après ceux qui en ont', () => {
    const boissons = o.sections.find(s => s.cle === 'boissons')!.ids;
    expect(boissons).toEqual(['b1', 'b2', 'b3']);   // 50, 20, puis « Eau » sans vente
  });
  test('les produits sans vente sont classés alphabétiquement, après ceux qui ont un historique', () => {
    const o2 = ordonnerCatalogue([p('x', 'Zèbre', 'divers'), p('y', 'Abricot', 'divers'), p('z', 'Maïs', 'divers')],
      { ...ctx, ventes: new Map([['z', 1]]), estNouveau: () => false });
    expect(o2.sections[0].ids).toEqual(['z', 'y', 'x']);
  });
  test('les indisponibles sont TOUS en dernier, dans une section à part, même s\'ils se vendaient le plus', () => {
    expect(idsTous(o).slice(-2).sort()).toEqual(['b4', 'c2']);
    expect(o.sections.at(-1)!.ids).toEqual(['b4', 'c2']);   // boissons avant chips (ordre métier)
  });
  test('chaque produit apparaît une seule fois', () => {
    expect(new Set(idsTous(o)).size).toBe(catalogue.length);
    expect(idsTous(o).length).toBe(catalogue.length);
  });
});

test.describe('Autres vues', () => {
  const o = ordonnerCatalogue(catalogue, ctx);
  test('catégorie choisie : plus vendus d\'abord, indisponibles en dernier', () => {
    const boissons = catalogue.filter(x => x.category === 'boissons').map(x => x.id);
    expect(trier(o.rang.categorie, boissons)).toEqual(['b1', 'b2', 'n2', 'b3', 'b4']);
  });
  test('recherche : nouveautés d\'abord, puis plus vendus, indisponibles en dernier', () => {
    const ids = trier(o.rang.recherche, catalogue.map(x => x.id));
    expect(ids.slice(0, 2)).toEqual(['n2', 'n1']);
    expect(ids.slice(2, 4)).toEqual(['b1', 'b2']);
    expect(ids.slice(-2)).toEqual(['b4', 'c2']);
  });
});

test.describe('Cas limites', () => {
  test('aucune nouveauté : la section n\'existe pas (aucun vide)', () => {
    const o = ordonnerCatalogue(catalogue, { ...ctx, estNouveau: () => false });
    expect(o.sections.map(s => s.cle)).not.toContain('nouveautes');
    expect(o.sections.every(s => s.ids.length > 0)).toBe(true);
  });
  test('aucune vente lue (échec de lecture) : tout reste affiché, par ordre alphabétique', () => {
    const o = ordonnerCatalogue(catalogue, { ...ctx, ventes: new Map() });
    expect(o.sections.find(s => s.cle === 'boissons')!.ids).toEqual(['b1', 'b3', 'b2']);   // Cola, Eau, Jus
  });
  test('catégorie inconnue ou vide : placée après les catégories métier, jamais perdue', () => {
    const o = ordonnerCatalogue([p('a', 'A', 'divers'), p('u', 'U', 'surgelés'), p('v', 'V', null)], { ...ctx, estNouveau: () => false });
    expect(idsTous(o).sort()).toEqual(['a', 'u', 'v']);
    expect(o.sections[0].cle).toBe('divers');
  });
  test('catalogue vide', () => {
    expect(ordonnerCatalogue([], ctx).sections).toEqual([]);
  });
  test('un nouveau produit indisponible reste parmi les indisponibles (jamais en tête)', () => {
    const o = ordonnerCatalogue(catalogue, { ...ctx, estDisponible: id => id !== 'n2' && !indispos.has(id) });
    expect(o.sections[0].ids).toEqual(['n1']);
    expect(o.sections.at(-1)!.ids).toContain('n2');
  });
});

test.describe('Constantes et contrôles de code', () => {
  const page = readFileSync('src/pages/catalogue.astro', 'utf8');
  const lib = readFileSync('src/lib/catalogue.ts', 'utf8');
  test('durée du badge et ordre métier des catégories paramétrables dans lib/constants.ts', () => {
    expect(NOUVEAU_DUREE_JOURS).toBe(30);
    expect([...CATALOGUE_ORDRE_CATEGORIES]).toEqual(['boissons', 'snacks', 'chips', 'confiseries', 'divers']);
    expect(readFileSync('src/lib/nouveau.ts', 'utf8')).not.toMatch(/NOUVEAU_DUREE_JOURS\s*=\s*30/);
  });
  test('le champ position n\'intervient plus dans l\'ordre client', () => {
    expect(page).not.toMatch(/order\(\s*['"]position['"]/);
  });
  test('une seule agrégation des ventes pour toute la page (aucune requête par produit)', () => {
    expect(page.match(/fetchVentesParProduit\(/g)).toHaveLength(1);
    expect(page).not.toMatch(/order_items/);
    const fn = lib.slice(lib.indexOf('export async function fetchVentesParProduit'));
    expect(fn.match(/\.from\('order_items'\)/g)).toHaveLength(1);
    expect(fn).toMatch(/REAPPRO_WEEKS_LOOKBACK/);
    expect(fn).toMatch(/\.range\(/);   // pagination : l'API plafonne chaque réponse
  });
  test('le filtre applique le bon ordre selon la vue et masque les en-têtes hors vue « Tous »', () => {
    expect(page).toMatch(/activeCat !== 'tous' \? 'rCat' : searchQuery \? 'rRecherche' : 'rTous'/);
    expect(page).toMatch(/t\.hidden = vue !== 'rTous'/);
  });
});
