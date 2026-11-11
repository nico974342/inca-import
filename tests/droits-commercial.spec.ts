/**
 * Droits du commercial : aucune donnée d'achat, de coût, de marge ou de frais d'import ne doit atteindre un commercial CÔTÉ SERVEUR
 * (pas seulement être masquée dans l'interface). Tests hors ligne sur le code source : aucune connexion, aucune écriture.
 */
import { test, expect } from '@playwright/test';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { cleTriProduits, CLES_TRI_PRODUITS } from '../src/lib/produitsTri';

const lire = (f: string) => readFileSync(f, 'utf8').replace(/\r\n/g, '\n');
const fichiers = (d: string, ext: RegExp): string[] => readdirSync(d).flatMap(n => { const p = join(d, n).replaceAll('\\', '/'); return statSync(p).isDirectory() ? fichiers(p, ext) : ext.test(n) ? [p] : []; });
/** Partie « gabarit » d'une page Astro : ce qui suit la frontmatter (donc ce qui part au navigateur). */
const gabarit = (s: string) => { const i = s.indexOf('\n---\n', s.indexOf('---') + 3); return i < 0 ? '' : s.slice(i + 5); };
const acces = /supabaseAdmin\s*\.|fetch(Availability|ReservedByProduct|DlcBadges|DlcOverview)\(/;
const COUT = /prix_achat|pump_snapshot|\.pump\b|unit_cost|amount_ht|shipment_costs|shipment_items|landed/;
const sansCommentaires = (s: string) => s.split('\n').filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

// Pages et routes qui exigent un administrateur : le contrôle doit précéder TOUT accès aux données.
const PAGES_ADMIN = ['src/pages/admin/achats.astro', 'src/pages/admin/achats/[id]/edit.astro', 'src/pages/admin/achats/[id]/couts.astro',
  'src/pages/admin/reception.astro', 'src/pages/admin/reception/new.astro', 'src/pages/admin/reception/[id]/edit.astro',
  'src/pages/admin/commande-fournisseur.astro', 'src/pages/admin/fournisseurs.astro', 'src/pages/admin/reappro.astro', 'src/pages/admin/marges.astro',
  'src/pages/admin/journal.astro', 'src/pages/admin/stocks/audit.astro', 'src/pages/admin/clients/performances.astro',
  'src/pages/admin/produits/[id]/edit.astro', 'src/pages/admin/produits/[id]/performance.astro', 'src/pages/admin/produits/new.astro', 'src/pages/admin/index.astro'];
const API_ADMIN = ['src/pages/api/admin/commande-fournisseur/marquer-commande.ts', 'src/pages/api/admin/commande-fournisseur/refresh-check.ts', 'src/pages/api/admin/commande-fournisseur/draft.ts',
  'src/pages/api/admin/reception/create.ts', 'src/pages/api/admin/reception/[id]/update.ts', 'src/pages/api/admin/reception/[id]/delete.ts', 'src/pages/api/admin/marges/export.ts'];

test.describe('Droits du commercial — coûts, achats, marges', () => {
  test('Suivi des achats, réception, commande fournisseur, marges… : le contrôle administrateur précède tout accès aux données (pages)', () => {
    for (const f of PAGES_ADMIN) {
      const s = lire(f); const garde = s.search(/if \(!isAdmin\(/); const premier = s.search(acces);
      expect(garde, `${f} : pas de contrôle administrateur`).toBeGreaterThan(-1);
      expect(s.slice(garde, garde + 160), f).toMatch(/return Astro\.redirect\('\/admin/);
      if (premier >= 0) expect(garde, `${f} : accès aux données AVANT le contrôle`).toBeLessThan(premier);
      const post = s.search(/request\.method === 'POST'/); if (post >= 0) expect(garde, `${f} : traitement du formulaire AVANT le contrôle`).toBeLessThan(post);
    }
  });

  test('mêmes routes d\'API : refus d\'un non-administrateur avant tout accès aux données', () => {
    for (const f of API_ADMIN) {
      const s = lire(f); const garde = s.search(/!isAdmin\(/); const premier = s.search(acces);
      expect(garde, `${f} : pas de contrôle administrateur`).toBeGreaterThan(-1);
      if (premier >= 0) expect(garde, `${f} : accès aux données AVANT le contrôle`).toBeLessThan(premier);
    }
  });

  test('les anciennes adresses /admin/transit ne donnent rien non plus : elles ne font que rediriger vers une page réservée', () => {
    for (const f of ['src/pages/admin/transit.astro', 'src/pages/admin/transit/[id]/edit.astro', 'src/pages/admin/transit/[id]/couts.astro']) expect(lire(f), f).not.toMatch(acces);
  });

  test('GARDE-FOU : toute page ou API ouverte au commercial qui lit un champ de coût est connue et revue (une nouvelle page en échec = à examiner)', () => {
    const reservees = new Set([...PAGES_ADMIN, ...API_ADMIN]);
    const REVUES = new Set([
      'src/pages/admin/clients/[id].astro',            // marge calculée côté serveur, affichée seulement si viewerIsAdmin
      'src/pages/admin/commande-rapide.astro',         // coût figé dans la commande côté serveur, jamais envoyé au navigateur
      'src/pages/admin/commandes.astro',               // marge affichée seulement si viewerIsAdmin
      'src/pages/admin/produits/index.astro',          // coûts et marges réservés à canManage (administrateur)
      'src/pages/api/admin/orders/[id]/update.ts',     // coût figé dans la ligne de commande côté serveur, jamais renvoyé
      'src/pages/api/admin/orders/[id]/delete.ts', 'src/pages/api/admin/clients/[id]/delete.ts',   // routes réservées à l'administrateur
      'src/pages/commande.astro',                      // page du client : coût figé côté serveur, jamais envoyé
    ]);
    const inconnues: string[] = [];
    for (const f of [...fichiers('src/pages', /\.(astro|ts)$/)]) {
      if (reservees.has(f) || f.startsWith('src/pages/admin/transit')) continue;
      if (COUT.test(sansCommentaires(lire(f))) && !REVUES.has(f)) inconnues.push(f);
    }
    expect(inconnues, 'page ouverte au commercial qui lit un champ de coût, non revue').toEqual([]);
  });

  test('Produits : coûts, marges et valeur de stock ne sont rendus que pour l\'administrateur (canManage)', () => {
    const g = gabarit(lire('src/pages/admin/produits/index.astro')).split('\n');
    g.forEach((l, i) => {
      // sur la ligne elle-même, ou dans le bloc {canManage && ( qui la contient
      if (/data-(stock-value|ca-calculable|marge|partial-stock)=/.test(l)) expect(g.slice(Math.max(0, i - 8), i + 1).join('\n'), `ligne ${i}`).toContain('canManage');
      if (/prix_achat_moyen_ht|margePct|margeInfo|\bpump\b/.test(l)) {
        const contexte = g.slice(Math.max(0, i - 8), i + 1).join('\n');
        expect(contexte, `coût rendu hors canManage : ${l.trim()}`).toContain('canManage');
      }
    });
  });

  test('Produits : le tri par marge est refusé au commercial côté serveur (sinon le classement révèle les marges)', () => {
    expect(cleTriProduits('marge', true)).toBe('marge');
    expect(cleTriProduits('marge', false)).toBe('');               // commercial : ordre par défaut
    for (const k of CLES_TRI_PRODUITS.filter(k => k !== 'marge')) { expect(cleTriProduits(k, false)).toBe(k); expect(cleTriProduits(k, true)).toBe(k); }
    expect(cleTriProduits('prix_achat_moyen_ht', true)).toBe(''); // aucun tri par un champ de coût
    expect(cleTriProduits('', false)).toBe(''); expect(cleTriProduits('nimporte', true)).toBe('');
    const page = lire('src/pages/admin/produits/index.astro');
    expect(page).toMatch(/cleTriProduits\(sortParam, canManage\)/);
    expect(page).not.toMatch(/SORT_KEYS as readonly string\[\]/);
  });

  test('Commandes et fiche client : la marge n\'est rendue que sous contrôle viewerIsAdmin', () => {
    // premier AFFICHAGE de la marge (le calcul serveur « const margin = » n'est pas rendu)
    const cmd = gabarit(lire('src/pages/admin/commandes.astro')); const premier = cmd.search(/\bmargin\.|\bmargin !== null/);
    expect(premier).toBeGreaterThan(-1);
    expect(cmd.slice(Math.max(0, premier - 60), premier + 40)).toContain('viewerIsAdmin');
    const cli = gabarit(lire('src/pages/admin/clients/[id].astro'));
    expect(cli.slice(Math.max(0, cli.search(/margeTotale/) - 200), cli.search(/margeTotale/))).toContain('viewerIsAdmin');
  });

  test('aucun champ de coût dans les données envoyées au navigateur : liste de la saisie rapide, page Stocks, API des stocks', () => {
    const rapide = lire('src/pages/admin/commande-rapide.astro');
    const bloc = rapide.slice(rapide.indexOf('const { data: productsRaw }'), rapide.indexOf('const CAT_LABEL'));
    expect(bloc).toContain('const products = (productsRaw'); expect(bloc).not.toMatch(COUT);
    const stocks = lire('src/pages/admin/stocks.astro'); const sel = stocks.slice(stocks.indexOf(".from('products')"), stocks.indexOf(".order('stock_quantity'"));
    expect(sel).not.toMatch(COUT); expect(sel).toContain('seuil_reappro');
    expect(lire('src/pages/api/produits/stocks.ts').slice(0, 1200)).not.toMatch(COUT);
    // Tableau de bord du commercial : aucune donnée d'achat
    expect(lire('src/pages/admin/tableau-de-bord.astro')).not.toMatch(/prix_achat|pump|unit_cost|amount_ht|shipment/);
  });

  test('BADGE : « Admin » pour un administrateur, « Commercial » pour un commercial (menu et barre du haut sur téléphone)', () => {
    const s = lire('src/components/admin/AdminLayout.astro');
    expect(s).toMatch(/const badgeRole = viewerIsAdmin \? ROLE_LABEL\.admin : ROLE_LABEL\.commercial;/);
    expect(s).toMatch(/<span class="sidebar-badge" data-testid="badge-role">\{badgeRole\}<\/span>/);
    expect(s).toMatch(/<span class="wm-admin" data-testid="badge-role-mobile">\{badgeRole\}<\/span>/);
    expect(s).not.toMatch(/sidebar-badge">Admin</); expect(s).not.toMatch(/wm-admin">Admin</);
    expect(lire('src/lib/roles.ts')).toMatch(/admin: 'Admin',\s*commercial: 'Commercial'/);
  });
});
