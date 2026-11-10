/**
 * Liaison BL ↔ commandes : règles pures (contenu figé, empreinte, droits du client) et contrôles de code des pages et routes.
 * Aucun accès réseau ni base.
 */
import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { empreinteCommande, construireContenuCommande, cleOperationCommande, cleOperationLivraison, estUuid, jetonValide } from '../src/lib/blCommande';
import { clientPeutConsulterBl } from '../src/lib/blAcces';
import { validerCommandesDuBl, type CommandeLue } from '../src/lib/blCommande';

const lire = (f: string) => readFileSync(f, 'utf8');
const UUID = '11111111-1111-1111-1111-111111111111';

test.describe('Empreinte et contenu figé d\'une commande', () => {
  const lignes = [
    { product_name: 'Cola 33cl', quantity: 12, unit: 'carton', price_ht_snapshot: 24.5, tva_rate_snapshot: 0.085 },
    { product_name: 'Eau 50cl', quantity: 4, unit: 'carton', price_ht_snapshot: 8, tva_rate_snapshot: 0.085 },
  ];
  test('stable, indépendante de l\'ordre des lignes ; change si un produit, une quantité ou un prix change', () => {
    const e = empreinteCommande(lignes);
    expect(e).toMatch(/^[0-9a-f]{32}$/);
    expect(empreinteCommande([...lignes].reverse())).toBe(e);
    expect(empreinteCommande([{ ...lignes[0], quantity: 13 }, lignes[1]])).not.toBe(e);
    expect(empreinteCommande([{ ...lignes[0], price_ht_snapshot: 25 }, lignes[1]])).not.toBe(e);
    expect(empreinteCommande([lignes[0]])).not.toBe(e);
    expect(empreinteCommande([{ ...lignes[0], price_ht_snapshot: '24.50' }, lignes[1]])).toBe(e);   // 24.5 ou « 24.50 » : même valeur
  });
  test('commande sans ligne : empreinte valide (jamais vide, la base l\'exige)', () => {
    expect(empreinteCommande([]).length).toBeGreaterThan(0);
  });
  test('contenu du BL : client, point de vente, adresses, unités par carton, date d\'émission', () => {
    const c = construireContenuCommande(
      { nom: 'Marie Client', societe: 'SARL Les Palmiers' },
      [{ ...lignes[0], sku: 'COLA33', units_per_carton: 24 }],
      { points_de_vente: 'Station Saint-Gilles', livraison_rue: '12 rue des Filaos', livraison_code_postal: '97434', livraison_ville: 'Saint-Gilles', facturation_same: true },
      '10/11/2026',
    );
    expect(c.date).toBe('10/11/2026');
    expect(c.pdv).toMatchObject({ name: 'Station Saint-Gilles', client_nom: 'Marie Client', client_societe: 'SARL Les Palmiers',
      client_address: '12 rue des Filaos, 97434 Saint-Gilles, La Réunion', client_facturation_address: '12 rue des Filaos, 97434 Saint-Gilles, La Réunion' });
    expect(c.pdv.items[0]).toMatchObject({ product_name: 'Cola 33cl', quantity: 12, sku: 'COLA33', units_per_carton: 24, price_ht: 24.5 });
  });
  test('sans fiche client : le BL se construit quand même (nom de la commande)', () => {
    const c = construireContenuCommande({ nom: 'Client X', societe: null }, [lignes[1]], null, '10/11/2026');
    expect(c.pdv.name).toBe('Client X'); expect(c.pdv.client_address).toBeNull();
  });
  test('clés d\'opération : stables, une par commande / par envoi et point de vente ; identifiants validés', () => {
    expect(cleOperationCommande(UUID)).toBe(`commande:${UUID}:initial`);
    expect(cleOperationLivraison(UUID, 'client_x')).toBe(`livraison:${UUID}:client_x`);
    expect(estUuid(UUID)).toBe(true); expect(estUuid('1; drop table')).toBe(false); expect(estUuid(undefined)).toBe(false);
    expect(jetonValide(UUID)).toBe(true); expect(jetonValide('abc')).toBe(false);
  });
});

test.describe('Droits du client sur un BL : jamais le BL d\'un autre client', () => {
  const moi = 'user-moi', autre = 'user-autre';
  const ctx = (liens: (string | null)[], extra: Partial<Parameters<typeof clientPeutConsulterBl>[0]> = {}) =>
    ({ userId: moi, accountId: 'compte-moi', noteClientId: null, liens: liens.map(user_id => ({ user_id })), ...extra });
  test('toutes les commandes du BL sont les miennes : accès', () => {
    expect(clientPeutConsulterBl(ctx([moi]))).toBe(true);
    expect(clientPeutConsulterBl(ctx([moi, moi, moi]))).toBe(true);
  });
  test('une commande d\'un autre compte : refus, même si la fiche client correspond', () => {
    expect(clientPeutConsulterBl(ctx([autre]))).toBe(false);
    expect(clientPeutConsulterBl(ctx([moi, autre]))).toBe(false);
    expect(clientPeutConsulterBl(ctx([moi, autre], { noteClientId: 'compte-moi' }))).toBe(false);
  });
  test('commandes sans compte (saisies par l\'équipe) : repli sur le rattachement à la fiche client, sinon refus', () => {
    expect(clientPeutConsulterBl(ctx([null], { noteClientId: 'compte-moi' }))).toBe(true);
    expect(clientPeutConsulterBl(ctx([null]))).toBe(false);
    expect(clientPeutConsulterBl(ctx([null], { noteClientId: 'compte-autre' }))).toBe(false);
    expect(clientPeutConsulterBl(ctx([moi, null], { noteClientId: 'compte-moi' }))).toBe(true);
    expect(clientPeutConsulterBl(ctx([moi, null], { noteClientId: 'compte-autre' }))).toBe(false);
  });
  test('BL sans commande (ancien BL, BL libre) : uniquement le rattachement à la fiche client', () => {
    expect(clientPeutConsulterBl(ctx([], { noteClientId: 'compte-moi' }))).toBe(true);
    expect(clientPeutConsulterBl(ctx([], { noteClientId: 'compte-autre' }))).toBe(false);
    expect(clientPeutConsulterBl(ctx([]))).toBe(false);
    expect(clientPeutConsulterBl(ctx([], { accountId: null, noteClientId: 'compte-moi' }))).toBe(false);
  });
});

test.describe('Contrôles de code : routes et pages', () => {
  const bl = lire('src/pages/api/admin/orders/[id]/bl.ts');
  const bon = lire('src/pages/api/admin/orders/[id]/bon-livraison.ts');
  const livraison = lire('src/pages/admin/livraison.astro');
  const commandes = lire('src/pages/admin/commandes.astro');
  const composant = lire('src/components/admin/BlCommande.astro');
  const signer = lire('src/pages/admin/bl/[id]/signer.astro');

  test('création d\'un BL : POST uniquement ; un GET est refusé (405) et ne crée rien', () => {
    expect(bl).toMatch(/export const POST: APIRoute/);
    expect(bl).toMatch(/export const GET: APIRoute = \(\) => new Response\([^)]*405/);
    expect(bl).toMatch(/creerBons\(depotBl/);
  });
  test('le lien « Bon de livraison » (GET) ne crée jamais de numéro : plus aucun next_bl_number ni écriture dans cette route', () => {
    expect(bon).not.toMatch(/next_bl_number|\.update\(|\.insert\(|\.upsert\(|\.delete\(/);
    expect(bon).toMatch(/lireBlOriginal/);                               // archive figée servie quand elle existe
    expect(bon).toMatch(/Aucun BL établi pour cette commande/);         // pas de BL : message, pas de création
  });
  test('aucun envoi d\'e-mail ni changement de statut, de stock ou de facturation dans la création, le téléchargement et la signature', () => {
    const fichiers = ['src/pages/api/admin/orders/[id]/bl.ts', 'src/pages/api/admin/orders/[id]/bon-livraison.ts', 'src/pages/api/delivery-notes/[id]/download.ts',
      'src/pages/api/delivery-notes/[id]/signe.ts', 'src/pages/api/admin/bl-signatures/index.ts', 'src/pages/api/admin/bl-signatures/[id]/annuler.ts',
      'src/pages/admin/bl/[id]/signer.astro', 'src/components/admin/BlCommande.astro', 'src/lib/blStockage.ts', 'src/lib/blArchive.ts', 'src/lib/blSignatures.ts'];
    for (const f of fichiers) {
      const c = lire(f);
      expect(c, f).not.toMatch(/resend|sendOrderStatusEmail|sendLowStockAlert|sendOrderConfirmedWebhook|lib\/email|lib\/webhooks/i);
      expect(c, f).not.toMatch(/from\('orders'\)\s*\.(update|delete|insert)|order_mark_livree|order_cancel_livree|stock_quantity|invoice_path/);
      expect(c, f).not.toMatch(/\.rpc\('order_/);
    }
  });
  test('le BL d\'une commande est rattaché par son identifiant, jamais par e-mail ; créé une seule fois (clé d\'opération)', () => {
    expect(bl).toMatch(/commandes: \[\{ order_id: id, empreinte/);
    expect(bl).toMatch(/cleOperationCommande\(id\)/);
    const lib = lire('src/lib/blSignatures.ts');
    expect(lib.slice(lib.indexOf('fetchBlsDesCommandes'))).not.toMatch(/\.eq\('email'|ilike\('email'/);
  });
  test('refus : commande annulée, ancien BL (signé sur papier) jamais régénéré, BL déjà existant sans nouveau numéro', () => {
    expect(bl).toMatch(/order\.status === 'annulee'/);
    expect(bl).toMatch(/signé sur papier : aucun nouveau BL n'est généré/);
    expect(bl).toMatch(/aucun nouveau numéro n'a été consommé/);
    expect(bl.indexOf('fetchBlsDesCommandes([id])')).toBeLessThan(bl.indexOf('creerBons(depotBl'));
    expect(bl.indexOf('verifierStockageBl(depotBl)')).toBeLessThan(bl.indexOf('creerBons(depotBl'));
  });
  test('Commandes : « Faire signer », « Terminer la signature », « BL signé (PDF) », statuts, signataires, avertissement, anciens BL « Signé sur papier »', () => {
    for (const t of ['Générer le BL', 'Faire signer', 'Terminer la signature', 'BL signé (PDF)', 'Signé sur papier', 'Commande modifiée depuis l\'émission du BL', 'BL regroupé', 'Bon de livraison {bl.numero}'])
      expect(composant, t).toContain(t);
    expect(composant).toMatch(/\/admin\/bl\/\$\{bl\.id\}\/signer/);              // « Faire signer » ouvre seulement l'écran existant
    expect(composant).toMatch(/method="post" action=\{`\/api\/admin\/orders\/\$\{orderId\}\/bl`\}/);   // création = POST explicite
    expect(composant).not.toMatch(/<a[^>]*\/bl`/);                               // aucun lien GET vers la création
    expect(commandes).toContain('<BlCommande');
    expect(commandes).toMatch(/fetchBlsDesCommandes\(orderIds\)/);               // un seul chargement pour la page
    expect(commandes).toMatch(/open=\{order\.id === ouvrirId\}/);
  });
  test('Livraison : aucune action de signature ; création commune, jeton d\'opération, commandes rattachées par point de vente', () => {
    expect(livraison).not.toMatch(/Faire signer|bons-de-livraison|bl-signatures|annuler une signature|sig_ok|sig_err|fetchSignaturesActives/i);
    expect(livraison).not.toMatch(/rpc\('next_bl_number'\)/);                  // plus de numérotation directe : bl_creer via creerBons
    expect(livraison).toMatch(/creerBons\(depotBl, specs\)/);
    expect(livraison).toMatch(/name="operation_id" value=\{jetonOperation\}/);
    expect(livraison).toMatch(/loaded_orders_\$\{m\.key\}/);
    expect(livraison.indexOf('verifierStockageBl(depotBl)')).toBeLessThan(livraison.indexOf('creerBons(depotBl, specs)'));
    expect(livraison.indexOf('creerBons(depotBl, specs)')).toBeLessThan(livraison.indexOf('resend.emails.send'));
  });
  test('Livraison : l\'e-mail ne part que pour les BL nouvellement créés (jamais pour un renvoi du même formulaire)', () => {
    expect(livraison).toMatch(/x\.b\.cree && x\.b\.pdf/);
    expect(livraison).toMatch(/nouveaux\.length === 0/);
    const debut = livraison.indexOf('nouveaux.length === 0');
    const apres = livraison.slice(debut, livraison.indexOf('} else {', debut));
    expect(apres).not.toContain('resend');
  });
  test('écran de signature : retour vers la commande, plus vers Livraison', () => {
    expect(signer).not.toMatch(/\/admin\/livraison/);
    expect(signer).toMatch(/href=\{retourCommande\}/);
  });
  test('suppressions : une commande ou un client rattaché à un BL ne se supprime pas (contrôle avant toute suppression)', () => {
    const cmd = lire('src/pages/api/admin/orders/[id]/delete.ts'), cli = lire('src/pages/api/admin/clients/[id]/delete.ts');
    expect(cmd.indexOf('delivery_note_orders')).toBeLessThan(cmd.indexOf("from('order_items').delete()"));
    expect(cmd).toMatch(/edit_error=bl_rattache/);
    expect(cli.indexOf("fail('bl_commande'")).toBeLessThan(cli.indexOf("from('order_items').delete()"));
    expect(commandes).toMatch(/bl_rattache:/);
  });
  test('droits : création / signature réservées au personnel (middleware /api/admin) ; le client ne passe que par les routes en lecture', () => {
    expect(lire('src/middleware.ts')).toMatch(/path\.startsWith\('\/api\/admin'\)/);
    for (const f of ['src/pages/api/delivery-notes/[id]/download.ts', 'src/pages/api/delivery-notes/[id]/signe.ts']) {
      const c = lire(f); expect(c, f).toMatch(/clientPeutConsulterBl/); expect(c, f).not.toMatch(/\.insert\(|\.update\(/);
    }
    expect(lire('src/pages/mes-livraisons.astro')).toMatch(/clientPeutConsulterBl/);
    const clientSign = execSync('git ls-files --others --cached "src/pages/**/*.ts" "src/pages/**/*.astro"', { encoding: 'utf8' }).split('\n').filter(Boolean)
      .filter(p => !p.includes('/admin/') && /sign/i.test(p));
    expect(clientSign).toEqual(['src/pages/api/delivery-notes/[id]/signe.ts']);
  });
  test('seuls les modules prévus touchent aux tables de liaison ; aucune écriture directe hors bl_creer', () => {
    const f = execSync('git grep --untracked -l -F "delivery_note_orders" -- src', { encoding: 'utf8' }).split('\n').filter(Boolean).sort();
    expect(f).toEqual(['src/lib/blSignatures.ts', 'src/pages/admin/bl/[id]/signer.astro', 'src/pages/api/admin/clients/[id]/delete.ts',
      'src/pages/api/admin/orders/[id]/delete.ts', 'src/pages/mes-livraisons.astro'].sort());
    for (const p of f) expect(lire(p), p).not.toMatch(/from\('delivery_note_orders'\)\s*\.(insert|update|delete|upsert)/);
  });
});

test.describe('Contrôle SERVEUR des commandes d\'un BL (jamais les identifiants du navigateur tels quels)', () => {
  const c = (id: string, extra: Partial<CommandeLue> = {}): [string, CommandeLue] => [id, { id, status: 'confirmee', bl_number: null, pdvKey: 'client_A', user_id: null, ...extra }];
  const base = (...l: [string, CommandeLue][]) => new Map(l);
  const A = 'aaaaaaaa-0000-0000-0000-000000000001', B = 'aaaaaaaa-0000-0000-0000-000000000002', C = 'aaaaaaaa-0000-0000-0000-000000000003';

  test('commandes du même point de vente et du même client : accepté (regroupement, livraison partielle)', () => {
    expect(validerCommandesDuBl('client_A', [A, B], base(c(A), c(B)))).toEqual({ ok: true });
    expect(validerCommandesDuBl('client_A', [A], base(c(A, { status: 'en_preparation' })))).toEqual({ ok: true });
    expect(validerCommandesDuBl('client_A', [A, B], base(c(A, { user_id: 'u1' }), c(B, { user_id: 'u1' })))).toEqual({ ok: true });
    expect(validerCommandesDuBl('client_A', [], base())).toEqual({ ok: true });                          // BL libre : rien à rattacher
  });
  test('commande d\'un AUTRE point de vente / client : refusé, même si l\'identifiant est valide', () => {
    const r = validerCommandesDuBl('client_A', [A, B], base(c(A), c(B, { pdvKey: 'client_B' })));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toMatch(/n'appartient pas à ce point de vente/);
    expect(validerCommandesDuBl('client_A', [A], base(c(A, { pdvKey: null }))).ok).toBe(false);          // commande non rattachable à un client : refusée
  });
  test('deux comptes clients différents dans un BL regroupé : refusé', () => {
    const r = validerCommandesDuBl('client_A', [A, B], base(c(A, { user_id: 'u1' }), c(B, { user_id: 'u2' })));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toMatch(/même compte client/);
  });
  test('ancien BL (signé sur papier) : refusé, jamais recréé', () => {
    const r = validerCommandesDuBl('client_A', [A], base(c(A, { bl_number: 'BL-0050' })));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toMatch(/ancien BL \(BL-0050\), signé sur papier/);
  });
  test('commande annulée, livrée ou inconnue : refusé ; identifiant en double : refusé', () => {
    for (const statut of ['annulee', 'livree', null]) expect(validerCommandesDuBl('client_A', [A], base(c(A, { status: statut }))).ok, String(statut)).toBe(false);
    expect(validerCommandesDuBl('client_A', [A, C], base(c(A))).ok).toBe(false);
    expect(validerCommandesDuBl('client_A', [A, A], base(c(A))).ok).toBe(false);
  });
  test('un seul refus suffit : aucune commande valide ne « sauve » le lot', () => {
    expect(validerCommandesDuBl('client_A', [A, B, C], base(c(A), c(B), c(C, { bl_number: 'BL-0001' }))).ok).toBe(false);
  });
  test('Livraison : le contrôle serveur a lieu AVANT toute création, avec la MÊME correspondance commande → point de vente que le chargement', () => {
    const l = lire('src/pages/admin/livraison.astro');
    expect(l).toMatch(/verifierCommandesDesBl\(pdvMeta\.map\(m => m\.key\), idsParPdv\)/);
    expect(l.indexOf('verifierCommandesDesBl(pdvMeta')).toBeLessThan(l.indexOf('creerBons(depotBl, specs)'));
    expect(l.match(/function pdvKeyDeCommande/g)).toHaveLength(1);
    expect(l).toMatch(/const key = pdvKeyDeCommande\(order as any\)/);                      // le préremplissage utilise la même règle
    expect(l).not.toMatch(/const byEmail\s+=.*\n.*const byNom[\s\S]{0,300}orderToPdvKey/);   // plus de seconde copie de la règle
  });
  test('la route « Générer le BL » refuse déjà un ancien BL ; la base le refuse aussi quel que soit le chemin', () => {
    expect(lire('src/pages/api/admin/orders/[id]/bl.ts')).toMatch(/bl_number/);
    expect(lire('supabase/migrations/bl_commandes.sql')).toMatch(/IF v_ancien IS NOT NULL THEN/);
  });
});
