/**
 * « Réception stock » et formulaires de réception de commande : le contenu doit occuper TOUTE la largeur à droite du menu latéral, sans plafond de largeur, avec des champs répartis sur
 * plusieurs colonnes en grand écran et une pile lisible sur téléphone.
 * Méthode : le CSS RÉEL de chaque page (bloc <style> du fichier .astro) et celui de la mise en page de l'administration (AdminLayout) sont chargés dans Chromium, avec un gabarit HTML qui
 * reprend les classes exactes des pages. Aucune base, aucun réseau. Présentation uniquement : aucune règle, aucun calcul, aucune donnée.
 */
import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';

const lire = (f: string) => readFileSync(f, 'utf8');
const style = (f: string) => [...lire(f).matchAll(/<style(?![^>]*is:global)[^>]*>([\s\S]*?)<\/style>/g)].map(m => m[1]).join('\n');
const GLOBAL = lire('src/styles/global.css');
const LAYOUT = style('src/components/admin/AdminLayout.astro');
const MENU = 220, MARGE = 32;       // largeur du menu latéral et marge intérieure du contenu (AdminLayout)

async function afficher(page: Page, css: string, contenu: string, largeur: number, hauteur = 900) {
  await page.setViewportSize({ width: largeur, height: hauteur });
  await page.setContent(`<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${GLOBAL}\n${LAYOUT}\n${css}</style></head>
  <body><div class="admin-shell"><aside class="admin-sidebar"><nav>menu</nav></aside><main class="admin-main"><div class="admin-page-header"><h1 class="admin-page-title">Titre</h1></div><div class="admin-content" id="zone">${contenu}</div></main></div></body></html>`);
}
const boite = async (page: Page, sel: string) => (await page.locator(sel).first().boundingBox())!;
const debord = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);

// ── Gabarits reprenant les classes des pages ──────────────────────────────────────────────────────────────
const CHAMPS_ENTETE = `<div class="field"><label class="label">Fournisseur</label><input class="input" value="SDR"></div><div class="field"><label class="label">Date</label><input class="input" type="date"></div><div class="field field--note"><label class="label">Notes</label><input class="input" value="BL"></div>`;
const LIGNES_TABLE = Array.from({ length: 6 }, (_, i) => `<tr class="item-row"><td class="col-product">Produit ${i}</td><td class="col-stock">10</td><td class="col-pump">4,20</td><td class="col-qty"><input class="input input--num"></td><td class="col-cost"><input class="input input--num"></td><td class="col-dlc"><input class="input" type="date"></td><td class="col-total">0</td><td class="col-action"><button class="remove-btn">×</button></td></tr>`).join('');
const FORM_NEW = `<div class="page-header"><a class="back-link" href="#">← Retour</a><h1 class="page-title">Nouvelle réception fournisseur</h1></div>
 <form class="reception-form" id="f"><section class="form-section" id="s1"><h2 class="section-title">Informations réception</h2><div class="form-grid" id="grille">${CHAMPS_ENTETE}</div></section>
 <section class="form-section" id="s2"><div class="section-header"><h2 class="section-title">Produits reçus</h2></div><div class="items-table-wrap" id="tw"><table class="items-table" id="itemsTable"><thead><tr><th class="col-product">Produit</th><th class="col-stock">Stock</th><th class="col-pump">PUMP</th><th class="col-qty">Qté</th><th class="col-cost">Coût</th><th class="col-dlc">DLC</th><th class="col-total">Total</th><th class="col-action"></th></tr></thead><tbody>${LIGNES_TABLE}</tbody></table></div></section></form>`;

for (const [nom, fichier] of [['Nouvelle réception', 'src/pages/admin/reception/new.astro'], ['Modifier la réception', 'src/pages/admin/reception/[id]/edit.astro']] as const) {
  test.describe(`${nom} (${fichier})`, () => {
    const css = style(fichier);
    test('aucun plafond de largeur : le formulaire et le tableau occupent toute la zone à droite du menu, de 1920 px à 820 px', async ({ page }) => {
      for (const largeur of [1920, 1440, 1100, 820]) {
        await afficher(page, css, FORM_NEW, largeur);
        const attendu = largeur - MENU - 2 * MARGE;
        const f = await boite(page, '#f'); const s1 = await boite(page, '#s1'); const s2 = await boite(page, '#s2');
        expect(Math.abs(f.width - attendu), `formulaire à ${largeur}px : ${f.width} au lieu de ${attendu}`).toBeLessThanOrEqual(2);
        expect(Math.abs(s1.width - attendu)).toBeLessThanOrEqual(2); expect(Math.abs(s2.width - attendu)).toBeLessThanOrEqual(2);
        expect(await debord(page)).toBeLessThanOrEqual(0);
      }
    });
    test('grand écran : fournisseur, date et notes sur UNE ligne ; écran moyen : 2 colonnes ; téléphone : 1 colonne', async ({ page }) => {
      await afficher(page, css, FORM_NEW, 1600);
      const y = async () => page.locator('#grille .field').evaluateAll(els => els.map(e => Math.round(e.getBoundingClientRect().top)));
      let tops = await y(); expect(new Set(tops).size, 'trois champs sur une ligne à 1600 px').toBe(1);
      const larg = await page.locator('#grille .field').evaluateAll(els => els.map(e => e.getBoundingClientRect().width));
      expect(Math.min(...larg)).toBeGreaterThan(200);                                      // champs larges, pas de petits champs perdus dans le vide
      await afficher(page, css, FORM_NEW, 900); tops = await y(); expect(new Set(tops).size, 'deux lignes à 900 px').toBe(2);
      await afficher(page, css, FORM_NEW, 390); tops = await y(); expect(new Set(tops).size, 'une pile à 390 px').toBe(3);
      expect(await debord(page)).toBeLessThanOrEqual(0);
    });
    test('le tableau des produits s\'étire avec l\'écran ; sur téléphone il défile DANS son cadre sans élargir la page', async ({ page }) => {
      await afficher(page, css, FORM_NEW, 1920);
      const t1 = await boite(page, '#itemsTable'); const w1 = await boite(page, '#tw'); expect(Math.abs(t1.width - w1.width)).toBeLessThanOrEqual(2); expect(t1.width).toBeGreaterThan(1300);
      await afficher(page, css, FORM_NEW, 390);
      expect(await debord(page)).toBeLessThanOrEqual(0);
      expect(await page.locator('#tw').evaluate(e => e.scrollWidth > e.clientWidth)).toBe(true);     // défilement interne au cadre du tableau
    });
  });
}

test.describe('Formulaire de réception d\'une commande fournisseur (src/pages/admin/achats/[id]/reception.astro)', () => {
  const css = style('src/pages/admin/achats/[id]/reception.astro');
  const LIGNE = (n: number, soldee = false) => soldee
    ? `<li class="rc-ligne rc-ligne--soldee"><div class="rc-nom"><strong>Produit ${n}</strong></div><dl class="rc-chiffres"><div><dt>Commandé</dt><dd>20</dd></div><div><dt>Déjà reçu</dt><dd>20</dd></div><div><dt>Reste</dt><dd>0</dd></div></dl><p class="rc-aide">Ligne soldée : rien à recevoir.</p></li>`
    : `<li class="rc-ligne"><div class="rc-nom"><strong>Produit ${n} avec un nom assez long pour la mise en page</strong></div><dl class="rc-chiffres"><div><dt>Commandé</dt><dd>100</dd></div><div><dt>Déjà reçu</dt><dd>40</dd></div><div><dt>Reste</dt><dd>60</dd></div></dl><div class="rc-saisie"><div class="rc-champ"><label>Reçu cette fois</label><div class="rc-qte"><input type="text" value=""><button type="button" class="rc-tout">Tout le reste (60)</button></div></div><div class="rc-champ"><label>Coût</label><input type="text"></div><div class="rc-champ"><label>DLC</label><input type="date"></div></div></li>`;
  const PAGE = `<div class="rc" id="rc"><a class="rc-retour" href="#">← Retour</a><h1 class="rc-h1">Enregistrer une réception</h1>
    <form class="rc-form"><div class="rc-entete" id="entete"><div class="rc-champ"><label>Date de livraison</label><input type="date"></div><div class="rc-champ"><label>BL</label><input type="text"></div><div class="rc-champ rc-champ--large"><label>Commentaire</label><input type="text"></div></div>
    <ul class="rc-lignes" id="lignes">${LIGNE(1)}${LIGNE(2)}${LIGNE(3, true)}${LIGNE(4)}</ul>
    <div class="rc-pied" id="pied"><p class="rc-total">Total de cette livraison : 0 carton</p><p class="rc-msg rc-msg--bloc" hidden></p><button type="submit" class="rc-envoyer">Enregistrer la réception</button><a class="rc-annuler" href="#">Annuler</a></div></form></div>`;

  test('aucun plafond de 760 px : la page occupe toute la zone à droite du menu', async ({ page }) => {
    expect(style('src/pages/admin/achats/[id]/reception.astro')).not.toMatch(/\.rc\s*\{[^}]*max-width/);
    for (const largeur of [1920, 1440, 1100]) { await afficher(page, css, PAGE, largeur); const b = await boite(page, '#rc'); expect(Math.abs(b.width - (largeur - MENU - 2 * MARGE)), `à ${largeur}px`).toBeLessThanOrEqual(2); expect(await debord(page)).toBeLessThanOrEqual(0); }
  });
  test('grand écran : en-tête sur une ligne ; chaque produit tient sur UNE ligne (nom | chiffres | saisie) au lieu d\'une pile étroite ; pied de page en barre', async ({ page }) => {
    await afficher(page, css, PAGE, 1600);
    const tops = await page.locator('#entete .rc-champ').evaluateAll(els => els.map(e => Math.round(e.getBoundingClientRect().top))); expect(new Set(tops).size).toBe(1);
    const ligne = page.locator('#lignes .rc-ligne').first();
    const [nom, chiffres, saisie] = await Promise.all(['.rc-nom', '.rc-chiffres', '.rc-saisie'].map(s => ligne.locator(s).boundingBox()));
    expect(Math.abs(nom!.y - chiffres!.y)).toBeLessThan(60); expect(chiffres!.x).toBeGreaterThan(nom!.x + nom!.width - 5); expect(saisie!.x).toBeGreaterThan(chiffres!.x + chiffres!.width - 5);   // trois colonnes côte à côte
    const hauteur = (await ligne.boundingBox())!.height; expect(hauteur).toBeLessThan(150);
    const pied = await boite(page, '#pied'); expect(pied.height).toBeLessThan(110);
    const bouton = await boite(page, '.rc-envoyer'); const total = await boite(page, '.rc-total'); expect(Math.abs(bouton.y - total.y)).toBeLessThan(60);
    const soldee = await boite(page, '.rc-ligne--soldee'); expect(soldee.height).toBeLessThan(110);
  });
  test('téléphone : pile verticale comme avant, aucun débordement, saisie sur deux colonnes', async ({ page }) => {
    await afficher(page, css, PAGE, 390);
    expect(await debord(page)).toBeLessThanOrEqual(0);
    const ligne = page.locator('#lignes .rc-ligne').first();
    const [nom, chiffres, saisie] = await Promise.all(['.rc-nom', '.rc-chiffres', '.rc-saisie'].map(s => ligne.locator(s).boundingBox()));
    expect(chiffres!.y).toBeGreaterThan(nom!.y + nom!.height - 2); expect(saisie!.y).toBeGreaterThan(chiffres!.y + chiffres!.height - 2);
    for (const el of await page.locator('#rc *').all()) { const b = await el.boundingBox(); if (b && b.width > 0) expect(b.x + b.width).toBeLessThanOrEqual(391); }
  });
});

test.describe('Liste « Réception stock » (src/pages/admin/reception.astro) et fiche de commande (src/pages/admin/achats/[id]/index.astro)', () => {
  const css = style('src/pages/admin/reception.astro');
  const CARTE = (n: number, lignes: number) => `<div class="reception-card"><div class="rec-header"><div class="rec-meta"><span class="rec-supplier">Fournisseur ${n}</span><span class="rec-date">12 nov. 2026</span><span class="rec-badge rec-badge--live">Stock appliqué</span></div><div class="rec-actions"><div class="rec-stats"><span class="rec-stat">${lignes} produits</span></div><a class="edit-btn" href="#">Modifier</a><button class="delete-btn">Supprimer</button></div></div><table class="rec-items"><thead><tr><th>Produit</th><th class="th-num">Qté</th><th class="th-num">Coût</th><th class="th-num">Total</th></tr></thead><tbody>${Array.from({ length: lignes }, (_, i) => `<tr><td>Produit ${i}</td><td class="td-num">10</td><td class="td-num">4,20 €</td><td class="td-num">42,00 €</td></tr>`).join('')}</tbody></table></div>`;
  const LISTE = `<div class="toolbar"><a class="btn btn-primary" href="#">+ Nouvelle réception</a></div><div class="reception-list" id="liste">${[3, 6, 2, 8, 4, 5].map((l, i) => CARTE(i + 1, l)).join('')}</div>`;
  test('la liste occupe toute la largeur et passe en plusieurs colonnes de cartes quand l\'écran le permet ; une colonne sur téléphone', async ({ page }) => {
    for (const [largeur, colonnes] of [[1920, 3], [1440, 2], [1100, 1], [820, 1], [390, 1]] as const) {
      await afficher(page, css, LISTE, largeur);
      const b = await boite(page, '#liste'); expect(Math.abs(b.width - (largeur <= 768 ? largeur - 2 * 20 : largeur - MENU - 2 * MARGE)), `liste à ${largeur}px`).toBeLessThanOrEqual(largeur <= 768 ? 24 : 2);
      const xs = await page.locator('#liste > .reception-card').evaluateAll(els => [...new Set(els.map(e => Math.round(e.getBoundingClientRect().left)))]);
      expect(xs.length, `colonnes à ${largeur}px`).toBe(colonnes);
      expect(await debord(page)).toBeLessThanOrEqual(0);
    }
  });
  test('fiche de commande : plus de plafond de 920 px', () => {
    expect(style('src/pages/admin/achats/[id]/index.astro')).not.toMatch(/\.ach\s*\{[^}]*max-width/);
    for (const f of ['src/pages/admin/reception.astro', 'src/pages/admin/reception/new.astro', 'src/pages/admin/reception/[id]/edit.astro', 'src/pages/admin/achats/[id]/reception.astro', 'src/pages/admin/achats/[id]/index.astro'])
      expect(style(f), f).not.toMatch(/(^|\n)\s*\.(rc|ach|reception-list|reception-form|form-section|page-header)\s*\{[^}]*max-width/);
  });
});
