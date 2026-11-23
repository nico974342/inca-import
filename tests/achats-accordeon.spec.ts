/**
 * Suivi des achats — liste COMPACTE en accordéon (src/components/admin/CommandeAccordeon.astro) : rendu RÉEL dans Chromium (Vite + conteneur Astro, CSS réel), trois largeurs d'écran.
 * Pure présentation : les nombres affichés viennent des mêmes fonctions de calcul qu'avant (etatReception, computeShipmentProgress, computeLandedCosts), jamais recalculés ici.
 * Aucune base, aucun réseau, aucune écriture : données de test uniquement.
 */
import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { etatReception, FILTRES_ACHATS, LIBELLE_FILTRE_ACHATS } from '../src/lib/achatsReception';
import { computeShipmentProgress, allocateCargoSlots, computeLandedCosts } from '../src/lib/constants';
import { rapprochementRequis } from '../src/lib/achatsRapprochement';
import { texteArrivee, resteAffiche, nombre } from '../src/lib/achatsAffichage';
import { rendrePage, arreter } from './helpers/renduAstro';

const FA1 = '2f1712b0-dff2-416d-b2e1-8293061af20b';
const lire = (f: string) => readFileSync(f, 'utf8');
const MAINTENANT = new Date('2026-11-23T09:00:00Z');

/** Construit une commande EXACTEMENT comme achats.astro (mêmes fonctions de calcul). */
function commande(o: { id: string; fournisseur: string; reference: string | null; status: string; eta: string | null; depart: string | null; lignes: { nom: string; q: number; recu: number | null; cout: number | null; upc?: number }[]; notes?: string }) {
  const items = o.lignes.map(l => {
    const pricePerUnit = l.cout != null && l.upc ? l.cout / l.upc : null;
    return { quantity: l.q, received_quantity: l.recu, cartons: l.q, unitsPerCarton: l.upc ?? null, totalUnits: l.upc ? l.q * l.upc : null, pricePerCarton: l.cout, pricePerUnit, totalValue: l.cout != null ? l.cout * l.q : null, unit_cost_ht: l.cout, product_id: 'p-' + l.nom, products: { name: l.nom, category: 'snack' }, dlc: null };
  });
  const etat = etatReception(items.map(i => ({ quantity: i.quantity, received_quantity: i.received_quantity })), o.status);
  const landed = computeLandedCosts(items.map(i => ({ product_id: i.product_id, quantity: i.quantity, unit_cost_ht: i.pricePerCarton })), []);
  return {
    id: o.id, supplier_name: o.fournisseur, reference: o.reference, status: o.status, eta: o.eta, departure_date: o.depart, notes: o.notes ?? null,
    items, totalQty: items.reduce((n, i) => n + i.quantity, 0), totalCost: items.reduce((n, i) => n + (i.unit_cost_ht ?? 0) * i.quantity, 0), anyMissingCost: items.some(i => i.unit_cost_ht == null),
    landed, etat, aRapprocher: rapprochementRequis(o.id, etat, 0), progress: computeShipmentProgress(o.depart, o.eta, o.status, MAINTENANT),
    cargo: allocateCargoSlots(items.map(i => ({ category: 'snack', quantity: i.quantity }))),
  };
}
const CMD_FA1 = commande({ id: FA1, fournisseur: 'SDR', reference: 'FA/1', status: 'commande', eta: '2026-10-30', depart: '2026-09-08', lignes: [{ nom: 'Milkshake Banane', q: 60, recu: null, cout: 17, upc: 12 }, { nom: 'Barre Dubai', q: 530, recu: null, cout: 13.91, upc: 12 }] });
const CMD_ECO = commande({ id: '6d06f66d-8842-410f-a78e-508d0dbea59e', fournisseur: 'ECO OI', reference: null, status: 'dedouanement', eta: '2026-11-06', depart: '2026-11-04', lignes: [{ nom: 'Produit ECO 1', q: 1000, recu: null, cout: 5 }, { nom: 'Produit ECO 2', q: 300, recu: null, cout: null }] });
const CMD_PARTIELLE = commande({ id: '11111111-1111-4111-8111-111111111111', fournisseur: 'Fournisseur Test', reference: 'BC/9', status: 'en_transit', eta: '2026-12-15', depart: '2026-11-20', notes: 'Livraison en deux fois', lignes: [{ nom: 'Cola 33cl', q: 100, recu: 40, cout: 10, upc: 24 }, { nom: 'Chips', q: 50, recu: 50, cout: 6 }] });
const CMD_RECUE = commande({ id: '22222222-2222-4222-8222-222222222222', fournisseur: 'Big Brand', reference: 'MSMU6919953', status: 'receptionne', eta: '2026-10-21', depart: '2026-09-08', lignes: [{ nom: 'Produit BB', q: 2291, recu: 2291, cout: 3 }] });
const TOUTES = [CMD_FA1, CMD_ECO, CMD_PARTIELLE, CMD_RECUE];

let pageHtml: string[] = [];
test.beforeAll(async () => {
  test.setTimeout(180_000);
  pageHtml = await Promise.all(TOUTES.map(s => rendrePage('/src/components/admin/CommandeAccordeon.astro', { s, ecritureOk: true }, ['/src/components/admin/ShipRoute.astro'])));
});
test.afterAll(async () => { await arreter(); });

/** Page de liste complète : le CSS vient de la première page, les 4 commandes sont assemblées dans le même document. */
async function ouvrirListe(page: Page, largeur: number, hauteur = 900) {
  const corps = pageHtml.map(h => h.match(/<main[^>]*>([\s\S]*)<\/main>/)![1]).join('\n');
  const css = pageHtml[0].match(/<style>([\s\S]*?)<\/style>/)![1];
  await page.setViewportSize({ width: largeur, height: hauteur });
  await page.setContent(`<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style></head><body><main style="padding:16px"><div class="shipments" style="display:flex;flex-direction:column;gap:8px">${corps}</div></main></body></html>`);
}
const sansEspaces = (s: string) => s.replace(/[  \s]+/g, ' ').trim();

test.describe('Accordéon des commandes : comportement dans un vrai navigateur', () => {
  test('PAR DÉFAUT toutes les commandes sont fermées : seule la ligne résumée est visible, aucun produit, aucune action', async ({ page }) => {
    await ouvrirListe(page, 1440);
    await expect(page.locator('details[data-testid="commande"]')).toHaveCount(4);
    expect(await page.locator('details[open]').count()).toBe(0);
    for (const s of TOUTES) {
      const d = page.locator(`details[data-commande="${s.id}"]`);
      await expect(d.locator('summary')).toBeVisible();
      await expect(d.locator('.sh-items')).toBeHidden();                       // produits masqués
      await expect(d.locator('.sh-actions')).toBeHidden();                     // actions masquées
      await expect(d.locator('[data-testid="enregistrer-reception"]')).toBeHidden();
    }
  });

  test('la ligne résumée donne l\'essentiel : fournisseur, référence, statuts, cartons commandés / reçus / reste, arrivée prévue, barre de progression', async ({ page }) => {
    await ouvrirListe(page, 1440);
    const partielle = page.locator(`details[data-commande="${CMD_PARTIELLE.id}"] summary`);
    const t = sansEspaces(await partielle.innerText());
    expect(t).toContain('Fournisseur Test'); expect(t).toContain('BC/9');
    expect(t).toContain('Partiellement réceptionnée'); expect(t).toContain(sansEspaces(`${nombre(150)} commandés`.replace(' commandés', '')));
    const chiffres = (col: string) => partielle.locator(`[data-col="${col}"]`).innerText();
    expect(sansEspaces(await chiffres('commande'))).toBe('150'); expect(sansEspaces(await chiffres('recu'))).toBe('90'); expect(sansEspaces(await chiffres('reste'))).toBe('60');
    expect(t).toContain('Arrivée prévue');
    const barre = partielle.locator('.cmd-barre');
    await expect(barre).toBeVisible(); expect(await barre.getAttribute('aria-valuenow')).toBe(String(CMD_PARTIELLE.etat.pourcentage));
    const eco = page.locator(`details[data-commande="${CMD_ECO.id}"] summary`);
    expect(sansEspaces(await eco.locator('[data-col="commande"]').innerText())).toBe('1 300'); expect(sansEspaces(await eco.locator('[data-col="recu"]').innerText())).toBe('0'); expect(sansEspaces(await eco.locator('[data-col="reste"]').innerText())).toBe('1 300');
    const recue = page.locator(`details[data-commande="${CMD_RECUE.id}"] summary`);
    expect(sansEspaces(await recue.locator('[data-col="reste"]').innerText())).toBe('0'); expect(sansEspaces(await recue.locator('[data-testid="arrivee"]').innerText())).toBe('');   // terminée : pas d'arrivée prévue
    expect(sansEspaces(await recue.innerText())).toContain('Réceptionnée intégralement');
  });

  test('un clic déplie : produits, quantités, prix et actions existantes apparaissent ; un second clic replie ; le clavier (Entrée, Espace) fait de même', async ({ page }) => {
    await ouvrirListe(page, 1440);
    const d = page.locator(`details[data-commande="${CMD_PARTIELLE.id}"]`);
    await d.locator('summary').click();
    await expect(d).toHaveAttribute('open', '');
    await expect(d.locator('.sh-items')).toBeVisible();
    const texte = sansEspaces(await d.locator('.sh-items').innerText());
    expect(texte).toContain('Cola 33cl'); expect(texte).toContain('100 cartons'); expect(texte).toContain('dont 40 reçus'); expect(texte).toContain('reste 60'); expect(texte).toContain('/ carton'); expect(texte).toContain('/ unité');
    await expect(d.locator('a', { hasText: 'Détail et réceptions' })).toBeVisible(); await expect(d.locator('a', { hasText: 'Modifier' })).toBeVisible();
    await expect(d.locator('select[name="status"]')).toBeVisible(); await expect(d.locator('[data-testid="enregistrer-reception"]')).toBeVisible();
    await expect(d.locator('.sh-landed')).toBeVisible(); expect(await d.locator('.sh-totals').innerText()).toContain('150');
    await d.locator('summary').click(); expect(await d.getAttribute('open')).toBeNull();
    await d.locator('summary').focus(); await page.keyboard.press('Enter'); await expect(d).toHaveAttribute('open', '');
    await page.keyboard.press('Space'); expect(await d.getAttribute('open')).toBeNull();
    expect(await page.locator('details[open]').count()).toBe(0);
  });

  test('FA/1 : AUCUN bouton « Enregistrer une réception » (même dépliée), message de rapprochement visible ; les autres commandes gardent leur bouton ; une commande soldée n\'en a pas', async ({ page }) => {
    await ouvrirListe(page, 1440);
    const fa1 = page.locator(`details[data-commande="${FA1}"]`); await fa1.locator('summary').click();
    await expect(fa1.locator('[data-testid="enregistrer-reception"]')).toHaveCount(0);
    await expect(fa1.locator('[data-testid="rapprochement"]')).toBeVisible();
    expect(sansEspaces(await fa1.locator('[data-testid="rapprochement"]').innerText())).toContain('rapprochement');
    for (const s of [CMD_ECO, CMD_PARTIELLE]) { const d = page.locator(`details[data-commande="${s.id}"]`); await d.locator('summary').click(); await expect(d.locator('[data-testid="enregistrer-reception"]')).toBeVisible(); }
    const recue = page.locator(`details[data-commande="${CMD_RECUE.id}"]`); await recue.locator('summary').click();
    await expect(recue.locator('[data-testid="enregistrer-reception"]')).toHaveCount(0); await expect(recue.locator('[data-testid="rapprochement"]')).toHaveCount(0);
  });

  test('écriture suspendue (gel, migration absente) : aucune action d\'écriture dépliée, le statut logistique n\'est plus modifiable', async ({ page }) => {
    const html = await rendrePage('/src/components/admin/CommandeAccordeon.astro', { s: CMD_ECO, ecritureOk: false }, ['/src/components/admin/ShipRoute.astro']);
    await page.setViewportSize({ width: 1200, height: 800 }); await page.setContent(html);
    await page.locator('summary').click();
    await expect(page.locator('[data-testid="enregistrer-reception"]')).toHaveCount(0); await expect(page.locator('select[name="status"]')).toHaveCount(0); await expect(page.locator('[data-testid="statut-logistique"]')).toBeVisible();
  });

  for (const [nom, largeur] of [['ordinateur', 1440], ['tablette', 820], ['téléphone', 390]] as const) {
    test(`responsive ${nom} (${largeur} px) : aucun débordement horizontal, ligne lisible, contenu déplié lisible`, async ({ page }) => {
      await ouvrirListe(page, largeur);
      const debord = () => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      expect(await debord()).toBeLessThanOrEqual(0);
      const hauteurs = await page.locator('summary').evaluateAll(els => els.map(e => Math.round(e.getBoundingClientRect().height)));
      if (largeur >= 1100) for (const h of hauteurs) expect(h).toBeLessThanOrEqual(84);       // une ligne compacte sur ordinateur
      for (const s of TOUTES) { const r = page.locator(`details[data-commande="${s.id}"] summary`); await expect(r).toBeVisible(); const b = await r.boundingBox(); expect(b!.width).toBeLessThanOrEqual(largeur); }
      // toutes dépliées : toujours aucun débordement de la page (les tableaux de produits restent dans la largeur)
      for (const s of TOUTES) await page.locator(`details[data-commande="${s.id}"] summary`).click();
      expect(await debord()).toBeLessThanOrEqual(0);
      for (const t of await page.locator('.sh-items').all()) { const b = await t.boundingBox(); expect(b!.x + b!.width).toBeLessThanOrEqual(largeur + 1); }
      // aucun contenu ne dépasse de sa carte (ni prix coupés, ni texte hors cadre) : défaut vu sur téléphone avant correction
      for (const s of TOUTES) { const d = page.locator(`details[data-commande="${s.id}"]`); const [sw, cw] = await d.evaluate(e => [e.scrollWidth, e.clientWidth]); expect(sw, `${s.supplier_name} : contenu plus large que la carte`).toBeLessThanOrEqual(cw + 1); }
      for (const c of await page.locator('.cmd-corps *').all()) { const r = await c.boundingBox(); if (r && r.width > 0) expect(r.x + r.width, 'élément hors écran').toBeLessThanOrEqual(largeur + 1); }
      if (largeur <= 520) { const b = await page.locator('details[data-commande="' + CMD_PARTIELLE.id + '"] .cmd-chiffres').boundingBox(); expect(b!.width).toBeGreaterThan(200); }
    });
  }

  test('pliées, 4 commandes tiennent sur un écran d\'ordinateur ; dépliées, une seule prend de la place (c\'est tout l\'intérêt de l\'accordéon)', async ({ page }) => {
    await ouvrirListe(page, 1440, 900);
    const hauteurPliee = await page.locator('.shipments').evaluate(e => Math.round(e.getBoundingClientRect().height));
    expect(hauteurPliee).toBeLessThan(450);
    await page.locator(`details[data-commande="${CMD_PARTIELLE.id}"] summary`).click();
    const hauteurUne = await page.locator('.shipments').evaluate(e => Math.round(e.getBoundingClientRect().height));
    expect(hauteurUne).toBeGreaterThan(hauteurPliee);
  });
});

test.describe('Accordéon : règles et contenu inchangés', () => {
  test('les quatre filtres actuels sont conservés (mêmes noms, mêmes valeurs) et la page ne contient plus de carte dépliée d\'office', () => {
    expect([...FILTRES_ACHATS]).toEqual(['en_cours', 'reste', 'partielles', 'toutes']);
    expect(LIBELLE_FILTRE_ACHATS).toEqual({ en_cours: 'En cours', reste: 'Reste à recevoir', partielles: 'Partiellement réceptionnées', toutes: 'Toutes (historique)' });
    const page = lire('src/pages/admin/achats.astro'); const comp = lire('src/components/admin/CommandeAccordeon.astro');
    expect(page).toContain('data-testid="filtres-achats"'); expect(page).toContain('FILTRES_ACHATS.map(f =>'); expect(page).toContain('<CommandeAccordeon s={s} ecritureOk={ecritureOk} />');
    expect(comp).toContain('<details class='); expect(comp).not.toMatch(/<details[^>]*\sopen[\s>=]/);                         // fermée par défaut : aucun attribut open
    expect(page).not.toContain('<article class="shipment');
  });

  test('aucune règle de calcul n\'est touchée par la présentation : le composant n\'accède à aucune donnée et ne calcule que de l\'affichage', () => {
    const comp = lire('src/components/admin/CommandeAccordeon.astro'); const aff = lire('src/lib/achatsAffichage.ts');
    expect(comp).not.toMatch(/supabase|\.rpc\(|\.from\(|fetch\(|method="post" action|received_quantity\s*=|stock_quantity|prix_achat/i);
    expect(comp).toContain('<input type="hidden" name="action" value="set_status" />');                                       // l'action existante est conservée telle quelle
    expect(aff).not.toMatch(/supabase|fetch\(|process\.env/);
    // la page calcule toujours l'état par les fonctions existantes
    const page = lire('src/pages/admin/achats.astro');
    expect(page).toContain('etatReception(rawItems.map'); expect(page).toContain('computeShipmentProgress('); expect(page).toContain('computeLandedCosts(');
  });

  test('helpers d\'affichage : arrivée prévue, reste à recevoir', () => {
    expect(texteArrivee({ status: 'en_transit', eta: null })).toBe('');
    expect(texteArrivee({ status: 'receptionne', eta: '2026-10-21' })).toBe(''); expect(texteArrivee({ status: 'annule', eta: '2026-10-21' })).toBe('');
    expect(texteArrivee({ status: 'commande', eta: '2026-10-30' })).toMatch(/^Arrivée prévue /); expect(texteArrivee({ status: 'commande', eta: '2026-10-30', late: true, daysLate: 24 })).toMatch(/· en retard de 24 j$/);
    expect(texteArrivee({ status: 'commande', eta: '2026-10-30', late: true, daysLate: 0 })).not.toContain('retard');
    expect(resteAffiche({ reste: 60, historique: false }, 'en_transit')).toBe(60); expect(resteAffiche({ reste: 60, historique: true }, 'receptionne')).toBe(0); expect(resteAffiche({ reste: 60, historique: false }, 'annule')).toBeNull();
  });

  test('FA/1 : la liste calcule la protection avec la MÊME règle que la fiche et le serveur ; les trois écrans comptent les réceptions non annulées', () => {
    expect(lire('src/pages/admin/achats.astro')).toContain('aRapprocher: rapprochementRequis((s as any).id, etat, 0)');
    expect(lire('src/components/admin/CommandeAccordeon.astro')).toContain("&& !s.aRapprocher;");
    for (const f of ['src/pages/admin/achats/[id]/index.astro', 'src/pages/admin/achats/[id]/reception.astro']) expect(lire(f), f).toContain('filter(r => !r.annulee_le).length');
    expect(rapprochementRequis(FA1, CMD_FA1.etat, 0)).toBe(true); expect(rapprochementRequis(CMD_ECO.id, CMD_ECO.etat, 0)).toBe(false);
    expect(CMD_FA1.aRapprocher).toBe(true); expect(CMD_ECO.aRapprocher).toBe(false);
  });
});
