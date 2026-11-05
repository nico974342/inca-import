/**
 * Badge « Nouveau » — contrôles de code des pages (aucun accès réseau, aucune écriture).
 */
import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';

const catalogue = readFileSync('src/pages/catalogue.astro', 'utf8');
const fiche = readFileSync('src/pages/admin/produits/[id]/edit.astro', 'utf8');

test.describe('Catalogue client', () => {
  test('badge sur la carte, onglet « Nouveautés » affiché seulement s\'il y en a, filtre côté navigateur', () => {
    expect(catalogue).toContain('data-testid="badge-nouveau"');
    expect(catalogue).toMatch(/nbNouveautes > 0 && \(\s*<button[^>]*data-cat="nouveautes"/);
    expect(catalogue).toMatch(/activeCat === 'nouveautes' \? card\.dataset\.nouveau === '1'/);
    expect(catalogue).toContain("catDemandee === 'nouveautes' && nbNouveautes === 0 ? 'tous'");
  });
  test('lecture tolérante : une erreur (migration pas appliquée) ne casse pas le catalogue', () => {
    expect(catalogue).toMatch(/nouveauErr \? \[\]/);
    // la requête principale du catalogue ne dépend pas des nouvelles colonnes
    const principale = catalogue.slice(catalogue.indexOf("const { data: products }"), catalogue.indexOf('.order(\'position\''));
    expect(principale).not.toMatch(/nouveau/);
  });
  test('l\'affichage passe par estNouveau (expiration calculée à la lecture, pas de tâche planifiée)', () => {
    expect(catalogue).toContain("import { estNouveau } from '../lib/nouveau'");
    expect(catalogue).toMatch(/filter\(r => estNouveau\(r, maintenant\)\)/);
  });
});

test.describe('Fiche produit', () => {
  test('section réservée aux administrateurs (la page redirige déjà les autres) et masquée si les colonnes manquent', () => {
    expect(fiche.indexOf('isAdmin(')).toBeLessThan(fiche.indexOf('nouveauRow'));
    expect(fiche).toMatch(/\{nouveauDispo && \(\s*<fieldset/);
    expect(fiche).toContain('data-testid="nouveau-actif"');
    expect(fiche).toContain('name="nouveau_fin"');
  });
  test('l\'enregistrement ne touche au badge que si la section est soumise et que la décision change quelque chose', () => {
    expect(fiche).toContain("data.get('nouveau_present') === '1'");
    expect(fiche).toContain('if (d.change)');
  });
  test('la fiche n\'écrit jamais le stock, les prix de façon nouvelle ni les champs d\'éligibilité', () => {
    const maj = fiche.slice(fiche.indexOf('.update({ nouveau_mode'), fiche.indexOf('.update({ nouveau_mode') + 200);
    expect(maj).not.toMatch(/stock_quantity|price_ht|nouveau_eligible|premiere_entree_stock_le/);
    expect(fiche).not.toMatch(/\.update\(\{[^}]*(nouveau_eligible|premiere_entree_stock_le)/);
  });
  test('activation et désactivation sont journalisées', () => {
    expect(fiche).toContain("'produit.nouveau_desactive'");
    expect(fiche).toContain("'produit.nouveau_active'");
  });
});

test.describe('Isolation', () => {
  test('aucun autre écran ne modifie les colonnes du badge (seule la fiche produit et le trigger)', async () => {
    const { execSync } = await import('node:child_process');
    const fichiers = execSync('git grep --untracked -l -E "nouveau_(mode|debut|fin|eligible)|premiere_entree_stock_le" -- src', { encoding: 'utf8' }).split('\n').filter(Boolean).sort();
    expect(fichiers).toEqual(['src/lib/nouveau.ts', 'src/pages/admin/produits/[id]/edit.astro', 'src/pages/catalogue.astro']);
  });
});
