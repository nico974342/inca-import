/**
 * Phase 1 — « Transit » devient « Suivi des achats » (/admin/achats), menu organisé en groupes.
 * Tests hors ligne : aucune connexion à Supabase, aucune écriture. La non-régression est prouvée en comparant les pages
 * déplacées à leur version d'AVANT la phase 1 (commit 818ad5c) : seules les modifications voulues sont autorisées.
 */
import { test, expect } from '@playwright/test';
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join } from 'node:path';
import { nouvelleAdresseAchats, statutRedirectionAchats } from '../src/lib/achatsRoutes';

const AVANT = '818ad5c';   // dernier commit de main avant la phase 1
const lire = (f: string) => readFileSync(f, 'utf8').replace(/\r\n/g, '\n');
const avant = (f: string) => execSync(`git show ${AVANT}:${f}`, { encoding: 'utf8', maxBuffer: 20_000_000 }).replace(/\r\n/g, '\n');

test.describe('Phase 1 — Suivi des achats', () => {
  test('redirection des anciennes adresses /admin/transit… vers /admin/achats…, identifiant et paramètres conservés', () => {
    expect(nouvelleAdresseAchats('/admin/transit')).toBe('/admin/achats');
    expect(nouvelleAdresseAchats('/admin/transit', '?ok=cree')).toBe('/admin/achats?ok=cree');
    expect(nouvelleAdresseAchats('/admin/transit/3f2a/edit', '?err=lignes')).toBe('/admin/achats/3f2a/edit?err=lignes');
    expect(nouvelleAdresseAchats('/admin/transit/3f2a/couts')).toBe('/admin/achats/3f2a/couts');
    expect(nouvelleAdresseAchats('/admin/achats')).toBeNull();                 // la nouvelle adresse n'est pas redirigée (pas de boucle)
    expect(nouvelleAdresseAchats('/admin/transitaire')).toBeNull();            // préfixe seulement : aucune confusion
    expect(statutRedirectionAchats('GET')).toBe(301);
    expect(statutRedirectionAchats('POST')).toBe(308);                         // un formulaire déjà ouvert garde sa méthode
  });

  test('les trois pages sont aux nouvelles adresses ; les anciennes ne sont que des redirections (aucun accès aux données)', () => {
    for (const f of ['src/pages/admin/achats.astro', 'src/pages/admin/achats/[id]/edit.astro', 'src/pages/admin/achats/[id]/couts.astro']) expect(existsSync(f), f).toBe(true);
    for (const f of ['src/pages/admin/transit.astro', 'src/pages/admin/transit/[id]/edit.astro', 'src/pages/admin/transit/[id]/couts.astro']) {
      const s = lire(f);
      expect(s, f).toMatch(/Astro\.redirect\(/); expect(s, f).toMatch(/nouvelleAdresseAchats/);
      expect(s, f).not.toMatch(/supabase|formData|logAdminAction/i);
      expect(s.split('\n').length, f).toBeLessThan(15);
    }
  });

  test('NON-RÉGRESSION : les pages déplacées sont identiques à leur version d\'avant, aux seuls changements voulus près', () => {
    const transforme = (s: string) => s
      .replaceAll('/admin/transit', '/admin/achats')
      .replaceAll('activeNav="transit"', 'activeNav="achats"')
      .replace('<AdminLayout title="Transit"', '<AdminLayout title="Suivi des achats"')
      .replace('    Marchandises parties de chez le fournisseur et pas encore arrivées.\n', '    Achats et expéditions en cours : marchandises commandées ou parties de chez le fournisseur, et pas encore arrivées.\n')
      .replaceAll('← Retour au suivi transit', '← Retour au Suivi des achats')
      .replace("Les tables de transit n'existent pas encore", "Les tables du Suivi des achats n'existent pas encore");
    for (const [ancien, nouveau] of [
      ['src/pages/admin/transit.astro', 'src/pages/admin/achats.astro'],
      ['src/pages/admin/transit/[id]/edit.astro', 'src/pages/admin/achats/[id]/edit.astro'],
      ['src/pages/admin/transit/[id]/couts.astro', 'src/pages/admin/achats/[id]/couts.astro'],
    ]) expect(lire(nouveau), nouveau).toBe(transforme(avant(ancien)));
  });

  test('les autres fichiers ne changent que par leurs liens et textes (réception, commande fournisseur, route marquer-commande)', () => {
    const changements: [string, (s: string) => string][] = [
      ['src/pages/admin/reception.astro', s => s.replaceAll('/admin/transit', '/admin/achats').replace('le suivi transit</a>', 'le Suivi des achats</a>')],
      ['src/pages/admin/reception/new.astro', s => s.replaceAll('/admin/transit', '/admin/achats')],
      ['src/pages/admin/commande-fournisseur.astro', s => s.replaceAll('/admin/transit', '/admin/achats')],
      ['src/pages/api/admin/commande-fournisseur/marquer-commande.ts', s => s.replaceAll('/admin/transit', '/admin/achats')],
    ];
    for (const [f, t] of changements) expect(lire(f), f).toBe(t(avant(f)));
  });

  test('plus aucun lien interne vers /admin/transit en dehors des redirections', () => {
    const trouves: string[] = [];
    const parcourir = (d: string) => { for (const n of readdirSync(d)) { const p = join(d, n); if (statSync(p).isDirectory()) parcourir(p); else if (/\.(astro|ts)$/.test(n) && lire(p).includes('/admin/transit')) trouves.push(p.replaceAll('\\', '/')); } };
    parcourir('src');
    expect(trouves.sort()).toEqual(['src/lib/achatsRoutes.ts']);
  });

  test('les clés d\'audit « transit.* » de l\'historique sont conservées, et le journal les affiche avec un libellé', () => {
    const cles = ['transit.creation', 'transit.suppression'];
    expect(lire('src/pages/admin/achats.astro')).toContain("'transit.creation'");
    expect(lire('src/pages/admin/achats.astro')).toContain("'transit.suppression'");
    expect(lire('src/pages/admin/achats/[id]/edit.astro')).toContain("'transit.modification'");
    expect(lire('src/pages/admin/achats/[id]/couts.astro')).toContain("'transit.frais_import'");
    const journal = lire('src/pages/admin/journal.astro');
    for (const c of [...cles, 'transit.modification', 'transit.frais_import', 'commande_fournisseur.marquer_commande']) {
      expect(journal.split(`'${c}'`).length - 1, c).toBe(2);   // un libellé et une couleur
    }
  });

  test('MENU : mêmes liens et mêmes règles de visibilité par rôle qu\'avant (seul Transit devient Suivi des achats), organisés en groupes', () => {
    const analyser = (src: string) => {
      const liens: { href: string; garde: string }[] = []; const titres: { label: string; garde: string; avantLien: string | null }[] = [];
      let garde = 'tous'; let dernier: string | null = null;
      const nav = src.slice(src.indexOf('<nav class="sidebar-nav">'), src.indexOf('</nav>'));
      for (const l of nav.split('\n')) {
        const g = l.match(/\{(viewerIsAdmin|viewerIsStaff) && (\(|<p)/);
        const titre = l.match(/<p class="nav-group"[^>]*>([^<]+)<\/p>/);
        if (titre) { titres.push({ label: titre[1], garde: g ? g[1] : 'tous', avantLien: null }); continue; }
        if (g && g[2] === '(') garde = g[1] === 'viewerIsAdmin' ? 'admin' : 'staff';
        const a = l.match(/<a href="([^"]+)" class=\{`nav-link/);
        if (a) { liens.push({ href: a[1], garde }); dernier = a[1]; }
        if (l.trim() === ')}') garde = 'tous';
      }
      return { liens, titres, dernier };
    };
    const ancien = analyser(avant('src/components/admin/AdminLayout.astro'));
    const nouveau = analyser(lire('src/components/admin/AdminLayout.astro'));
    const norm = (l: { href: string; garde: string }[]) => l.map(x => `${x.garde}:${x.href}`).sort();
    expect(norm(ancien.liens)).toContain('admin:/admin/transit');
    // seuls changements depuis la phase 1 : Transit → Suivi des achats, Portefeuilles et Aujourd'hui (tout le personnel), Activités (administrateur)
    expect(norm(nouveau.liens)).toEqual([...norm(ancien.liens).map(x => x === 'admin:/admin/transit' ? 'admin:/admin/achats' : x), 'tous:/admin/portefeuilles', 'tous:/admin/aujourdhui', 'admin:/admin/activites'].sort());
    expect(nouveau.liens.length).toBe(18);
    // Ordre par groupe
    const ordre = nouveau.liens.map(x => x.href);
    expect(ordre).toEqual(['/admin', '/admin/aujourdhui', '/admin/clients', '/admin/portefeuilles', '/admin/activites', '/admin/tarifs', '/admin/commande-rapide', '/admin/preparation', '/admin/commandes', '/admin/livraison',
      '/admin/produits', '/admin/stocks', '/admin/commande-fournisseur', '/admin/achats', '/admin/reception', '/admin/fournisseurs', '/admin/marges', '/admin/journal']);
    expect(nouveau.titres).toEqual([
      { label: 'Ventes', garde: 'tous', avantLien: null }, { label: 'Achats et stock', garde: 'tous', avantLien: null }, { label: 'Gestion', garde: 'viewerIsAdmin', avantLien: null }]);
    // Le titre « Gestion » (marges, journal : administrateur seulement) est lui-même réservé à l'administrateur
    const src = lire('src/components/admin/AdminLayout.astro');
    expect(src).toMatch(/\{viewerIsAdmin && <p class="nav-group" role="presentation">Gestion<\/p>\}/);
    expect(src).toContain('Suivi des achats');
    expect(src).not.toMatch(/>\s*Transit\s*</);
    expect(src).toMatch(/activeNav\?: [^\n]*'achats'/); expect(src).not.toMatch(/activeNav\?: [^\n]*'transit'/);
  });

  test('aucune page ne passe plus activeNav="transit"', () => {
    const fautives: string[] = [];
    const parcourir = (d: string) => { for (const n of readdirSync(d)) { const p = join(d, n); if (statSync(p).isDirectory()) parcourir(p); else if (n.endsWith('.astro') && /activeNav="transit"/.test(lire(p))) fautives.push(p); } };
    parcourir('src/pages');
    expect(fautives).toEqual([]);
  });
});
