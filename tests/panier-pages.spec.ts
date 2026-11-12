/**
 * Panier / commande : contrôles du code des pages et des routes (aucune connexion, aucune écriture). Vérifie les garanties qui ne se voient pas dans un test de données :
 * pas de retrait silencieux, pas de vidage avant la création, pas de second e-mail sur un doublon, pas de renvoi au catalogue après un refus, et aucun effet sur la saisie
 * administrateur (commande rapide, modification d'une commande).
 */
import { test, expect } from '@playwright/test';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const lire = (f: string) => readFileSync(f, 'utf8').replace(/\r\n/g, '\n');
const page = lire('src/pages/commande.astro');
const sans = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const fichiers = (d: string): string[] => readdirSync(d).flatMap(f => { const p = join(d, f); return statSync(p).isDirectory() ? fichiers(p) : [p]; });

test.describe('Page /commande', () => {
  test('aucun retrait silencieux : la page ne supprime jamais de ligne du panier elle-même (seulement par les actions explicites de la bibliothèque)', () => {
    expect(sans(page)).not.toMatch(/\.delete\(\)/);
    expect(page).not.toContain('maskedInCart'); expect(page).not.toContain('hiddenInCart'); expect(page).not.toContain('removedHiddenFromCart');
    const actions = lire('src/lib/commandeActions.ts');
    expect(actions.match(/depot\.retirer\(/g)?.length).toBe(2);                                              // retrait explicite d'une ligne + plan confirmé
    expect(actions).toMatch(/if \(etat\.signature !== signatureAffichee\)/);                                  // plan appliqué seulement s'il est encore celui qui était affiché
  });

  test('le panier est lu et vidé uniquement par la bibliothèque : vidage APRÈS la création confirmée, avec vérification', () => {
    const actions = lire('src/lib/commandeActions.ts');
    const creation = actions.indexOf('r = await createur.creer(cle, lignes)'); const vidage = actions.indexOf('depot.viderPanier(userId)', creation);
    expect(creation).toBeGreaterThan(-1); expect(vidage).toBeGreaterThan(creation);
    expect(actions).toMatch(/if \(!r\.ok\) return 'conflicts' in r/);                                         // refus = retour AVANT le vidage
    const depot = lire('src/lib/commandeSupabase.ts');
    expect(depot).toMatch(/viderPanier[\s\S]*count[\s\S]*=== 0/);                                             // « vidé » seulement si constaté
  });

  test('refus de stock : retour à la page de commande (jamais au catalogue), sans passer le détail par l\'adresse', () => {
    const i = page.indexOf("res.type === 'conflits'"); expect(i).toBeGreaterThan(-1);
    expect(page.slice(i, i + 160)).toContain("Astro.redirect('/commande?error=stock')");
    expect(page).not.toMatch(/[?&]detail=/); expect(page).not.toContain('encodeURIComponent(describeConflicts');
    const envoi = page.slice(page.indexOf("// — Envoi de la commande —"), page.indexOf('// ── GET: show cart'));
    expect(envoi.match(/Astro\.redirect\('\/catalogue'\)/g)?.length).toBe(1);                                  // seulement le panier réellement vide, jamais un refus
    expect(envoi.slice(envoi.indexOf("res.type === 'panier_vide'"), envoi.indexOf("res.type === 'panier_vide'") + 80)).toContain('/catalogue');
  });

  test('doublon (même clé, double clic, nouvel essai) : ni nouvelle commande, ni nouvel e-mail, ni nouveau PDF', () => {
    const deja = page.indexOf('if (res.deja) return Astro.redirect'); const alt = page.indexOf("res.type === 'deja_enregistree'");
    expect(alt).toBeGreaterThan(-1); expect(deja).toBeGreaterThan(-1);
    expect(deja).toBeLessThan(page.indexOf('generateOrderPDF({')); expect(deja).toBeLessThan(page.indexOf('resend.emails.send('));
    expect(alt).toBeLessThan(page.indexOf('generateOrderPDF({'));
    expect(page).toContain('<input type="hidden" name="cle" value={cleEnvoi} />'); expect(page).toContain('const cleEnvoi      = crypto.randomUUID();');
  });

  test('contrôle final côté serveur : la création passe par la base (création contrôlée), la disponibilité de la page est le réel (physique − réservé), recalculée à chaque affichage', () => {
    // la création passe TOUJOURS par la fonction sécurisée ; absente ou injoignable, l'envoi est refusé (jamais de repli sur une création moins sûre)
    expect(page).toContain('return createOrderIdempotent(cleEnvoi, entete, lignesCmd);'); expect(page).not.toContain('createOrderChecked');
    const creer = page.slice(page.indexOf('async creer(cleEnvoi'), page.indexOf('return createOrderIdempotent('));
    expect(creer.indexOf('idempotenceDisponible()')).toBeGreaterThan(-1); expect(creer.indexOf("error: 'ENVOI_INDISPONIBLE'")).toBeGreaterThan(-1);
    expect(creer.indexOf('idempotenceDisponible()')).toBeLessThan(creer.indexOf(".from('cart_items')"));          // refus AVANT toute lecture ou création
    expect(page).toContain("Astro.redirect('/commande?error=indisponible')"); expect(page).toContain('data-testid="envoi-indisponible"');
    expect(page).toContain("res.code === 'CLE_REUTILISEE_AUTRES_DONNEES'");                                       // clé réutilisée avec un autre contenu : message clair
    const stock = lire('src/lib/stock.ts'); expect(stock).toContain("/CLE_REQUISE/.test(String(error.message ?? ''))");   // la sonde exige la réponse EXACTE de la fonction
    expect(stock.slice(stock.indexOf('export async function createOrderIdempotent'))).not.toContain('createOrderChecked(');   // aucun repli dans la bibliothèque
    expect(page).toContain('etat = await etatPanier(depot, user.id)');
    const supa = lire('src/lib/commandeSupabase.ts'); expect(supa).toContain(".from('product_availability')"); expect(supa).toMatch(/if \(e1 \|\| e2\) throw/);   // lecture impossible ≠ « disponible »
    expect(page).not.toContain('data-stock=');                                                                // plus de stock physique côté navigateur
  });

  test('actions explicites sécurisées : identifiant validé, quantité jamais lue du formulaire, compte actif exigé, résultat visible (message) ; page de succès limitée aux commandes du client', () => {
    expect(page).toContain("if (!estUuid(pid)) return Astro.redirect('/commande')");
    const bloc = page.slice(page.indexOf("if (action === 'retirer' || action === 'reduire')"), page.indexOf("if (action === 'ajuster_apercu')"));
    expect(bloc).not.toMatch(/form\.get\('(quantite|qty|quantity)'\)/); expect(bloc).toContain('poserFlash(');
    expect(page.indexOf('if (!accountActive) return Astro.redirect')).toBeLessThan(page.indexOf("const action = String(form.get('action')"));
    expect(page).toMatch(/\.from\('orders'\)\.select\('id'\)\.eq\('id', orderId\)\.eq\('user_id', user\.id\)/);
    expect(page).toContain("if (!mienne) return Astro.redirect('/mes-commandes');");                              // la commande d'un autre n'est ni affichée ni confirmée
    expect(page).toContain("if (Astro.url.searchParams.get('success') && !orderId) return Astro.redirect('/commande');");   // pas de « commande reçue » sans commande identifiée
    expect(page.indexOf('if (!mienne)')).toBeLessThan(page.indexOf(".from('order_items')"));                      // les lignes ne sont lues qu'une fois la propriété vérifiée
    expect(page).toContain('{flash && !success && ('); expect(page).toContain('data-testid="apercu-ajustement"'); expect(page).toContain('data-testid="continuer-disponibles"');
  });

  test('envoi : verrou contre le double clic, même clé à chaque nouvel essai, vérification de la commande après une coupure réseau, panier conservé annoncé', () => {
    const js = page.slice(page.indexOf('<script>'));
    expect(js).toContain('if (enCours || btn.disabled) return;'); expect(js).toContain("btn.textContent = 'Envoi en cours…'");
    expect(js).toContain('/api/commande/statut?cle='); expect(js).toContain('if (v?.enregistree && v.orderId)'); expect(js).toContain('Votre panier est conservé');
    expect(js).toContain('.persisted'); expect(js).toContain('new FormData(form)');                           // la même clé (champ caché) est renvoyée
  });

  test('téléphone : lignes en fiches, boutons de 44 px, actions pleine largeur', () => {
    expect(page).toContain('@media (max-width: 640px)'); expect(page).toContain('min-height: 44px'); expect(page).toContain('.stock-inline { flex: 1 1 100%; }');
  });
});

test.describe('Routes et catalogue', () => {
  test('ajout au panier : plafonné au disponible RÉEL, réponse explicite (quantité réduite, rupture) ; réservé aux clients', () => {
    const add = lire('src/pages/api/cart/add.ts');
    expect(add).toContain("from('product_availability')"); expect(add).toContain('clamped: finalQty < qty'); expect(add).toContain("json(409, { error: 'Rupture de stock'"); expect(add).toContain('isClientRole(user)');
  });
  test('vérification d\'une commande après coupure : réservée au client connecté, limitée à SES commandes, lecture seule', () => {
    const s = lire('src/pages/api/commande/statut.ts');
    expect(s).toContain('export const GET'); expect(s).not.toMatch(/export const (POST|PUT|DELETE|PATCH)/); expect(s).toContain('isClientRole(user)');
    expect((s.match(/\.eq\('user_id', user\.id\)/g) ?? []).length).toBeGreaterThanOrEqual(2); expect(sans(s)).not.toMatch(/\.(insert|update|delete|upsert|rpc)\(/);
  });
  test('catalogue : plus d\'échec silencieux (réponse du serveur prise en compte, nouvel essai, message visible)', () => {
    const c = lire('src/pages/catalogue.astro');
    expect(c).toContain('afficherSync('); expect(c).toContain('r.status === 409'); expect(c).toContain('for (let essai = 0; essai < 3; essai++)'); expect(c).toContain('id="cartSyncMsg"'); expect(c).not.toContain('Optimistic update — silent fail');
  });
});

test.describe('Saisie administrateur et autres parcours : inchangés', () => {
  test('les fonctions de création et de modification contrôlées existantes ne sont pas modifiées', () => {
    const stock = lire('src/lib/stock.ts');
    expect(stock).toContain("supabaseAdmin.rpc('order_create_checked', {\n    p_order: order,\n    p_items: items,\n  })");
    expect(stock).toContain("supabaseAdmin.rpc('order_update_checked', {"); expect(stock).toContain('export async function createOrderChecked('); expect(stock).toContain('export function describeConflicts(');
  });
  test('commande rapide et modification d\'une commande utilisent toujours le même chemin contrôlé et ne dépendent pas du nouveau parcours client', () => {
    expect(lire('src/pages/admin/commande-rapide.astro')).toContain('createOrderChecked'); expect(lire('src/pages/api/admin/orders/[id]/update.ts')).toContain('updateOrderChecked');
    const nouveaux = ['commandeActions', 'commandeSupabase', 'lib/panier', 'idempotenceDisponible', 'createOrderIdempotent', 'achatsTransition'];
    for (const f of fichiers('src/pages/admin').concat(fichiers('src/pages/api/admin'))) { const s = lire(f); for (const n of nouveaux) if (n !== 'achatsTransition') expect(s, `${f} ne doit pas dépendre de ${n}`).not.toContain(n); }
    expect(lire('src/pages/admin/commande-rapide.astro')).toContain('allow_hidden_products');               // la saisie staff garde son droit sur les produits masqués
  });
  test('les anciens liens et paramètres de la page restent compris (success, order, error=1, error=compte_non_actif)', () => {
    expect(page).toContain("Astro.url.searchParams.get('success')"); expect(page).toContain("'/commande?error=compte_non_actif'"); expect(page).toContain("'/commande?error=1'");
  });
});
