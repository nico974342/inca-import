/**
 * Signature électronique des BL — règles serveur, PDF signé, contrôles de code. Aucun accès réseau ni base.
 */
import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { inflateSync } from 'node:zlib';
import { etatSignature, validerNom, validerImageSignature, pixelsTraces, PIXELS_TRACES_MIN } from '../src/lib/signatureBl';
import { generatePDVDeliveryPDF } from '../src/lib/pdf';
import { fabriquerPng, versDataUrl, signatureTest } from './helpers/png';

test.describe('État de signature', () => {
  test('non signé / partiel / signé ; les signatures annulées ne comptent pas', () => {
    expect(etatSignature([])).toBe('non_signe');
    expect(etatSignature([{ role: 'transporteur' }])).toBe('partiel');
    expect(etatSignature([{ role: 'destinataire' }])).toBe('partiel');
    expect(etatSignature([{ role: 'transporteur' }, { role: 'destinataire' }])).toBe('signe');
    expect(etatSignature([{ role: 'transporteur' }, { role: 'destinataire', annulee_le: '2026-11-10T10:00:00Z' }])).toBe('partiel');
    expect(etatSignature([{ role: 'transporteur', annulee_le: 'x' }, { role: 'destinataire', annulee_le: 'x' }])).toBe('non_signe');
  });
});

test.describe('Nom du signataire', () => {
  test('obligatoire, nettoyé, limité à 100 caractères', () => {
    expect(validerNom('  Marie   Client ')).toEqual({ ok: true, nom: 'Marie Client' });
    expect(validerNom('Jean\u0000\nDupont')).toEqual({ ok: true, nom: 'Jean Dupont' });
    for (const x of ['', '   ', null, undefined, 42]) expect(validerNom(x).ok).toBe(false);
    expect(validerNom('x'.repeat(101)).ok).toBe(false);
  });
});

test.describe('Image de signature', () => {
  const sig = signatureTest();
  test('une vraie signature est acceptée', () => {
    expect(pixelsTraces(sig)!).toBeGreaterThan(PIXELS_TRACES_MIN);
    expect(validerImageSignature(versDataUrl(sig)).ok).toBe(true);
  });
  test('lecture correcte avec les différents filtres PNG (le navigateur peut en utiliser plusieurs)', () => {
    const trace = (x: number, y: number) => Math.abs(y - 100) < 3 && x > 50 && x < 400;
    const a = pixelsTraces(fabriquerPng(450, 200, trace, 0)), b = pixelsTraces(fabriquerPng(450, 200, trace, 2));
    expect(a).toBeGreaterThan(1000);
    expect(b).toBe(a);
  });
  test('cadre vide, simple point ou trait minuscule : refusés', () => {
    expect(validerImageSignature(versDataUrl(fabriquerPng(900, 540))).ok).toBe(false);
    expect(validerImageSignature(versDataUrl(fabriquerPng(900, 540, (x, y) => Math.hypot(x - 450, y - 270) < 5))).ok).toBe(false);
  });
  test('refuse ce qui n\'est pas un PNG, un préfixe différent, du base64 invalide, une image trop lourde', () => {
    expect(validerImageSignature('data:image/jpeg;base64,' + sig.toString('base64')).ok).toBe(false);
    expect(validerImageSignature('data:image/png;base64,' + Buffer.from('<script>alert(1)</script>').toString('base64')).ok).toBe(false);
    expect(validerImageSignature('data:image/png;base64,@@@').ok).toBe(false);
    expect(validerImageSignature('data:image/png;base64,' + 'A'.repeat(400_100)).ok).toBe(false);
    expect(validerImageSignature(undefined).ok).toBe(false);
    expect(validerImageSignature(12).ok).toBe(false);
  });
});

test.describe('PDF du BL signé', () => {
  const pdv = {
    name: 'Station Test', client_nom: 'Marie Client', client_societe: 'SARL Test', client_address: '1 rue du Test, 97400 Saint-Denis, La Réunion',
    items: Array.from({ length: 5 }, (_, i) => ({ product_name: `Produit ${i + 1}`, quantity: 3 + i, units_per_carton: 24, sku: `SKU${i}` })),
  };
  const data = versDataUrl(signatureTest());
  const sigs = {
    transporteur: { data, nom: 'Gérald Incana', dateLabel: '10/11/2026 09:15' },
    destinataire: { data, nom: 'Paul Destinataire', dateLabel: '10/11/2026 09:17' },
  };
  const images = (pdf: Buffer) => (pdf.toString('latin1').match(/\/Subtype \/Image/g) ?? []).length;
  // Texte lisible : fragments hexadécimaux des opérateurs TJ/Tj (PDF généré sans compression pour ce contrôle)
  const texte = (pdf: Buffer) => [...pdf.toString('latin1').matchAll(/\[([^\]]*)\]\s*TJ|<([0-9a-fA-F]+)>\s*Tj/g)]
    .map(m => [...(m[1] ?? `<${m[2]}>`).matchAll(/<([0-9a-fA-F]+)>/g)].map(h => Buffer.from(h[1], 'hex').toString('latin1')).join('')).join('\n');

  test('non signé : aucune image dans le PDF (comme aujourd\'hui) ; signé : une image par signature, avec nom et date dessous', async () => {
    const nonSigne = await generatePDVDeliveryPDF(pdv, 'BL-0042', '10/11/2026', undefined, { compress: false });
    const signe = await generatePDVDeliveryPDF(pdv, 'BL-0042', '10/11/2026', sigs, { compress: false });
    expect(images(nonSigne)).toBe(0);
    expect(images(signe)).toBeGreaterThanOrEqual(2);
    const t = texte(signe);
    expect(t).toContain('Gérald Incana');
    expect(t).toContain('Paul Destinataire');
    expect(t).toContain('10/11/2026 09:15');
    expect(t).toContain('10/11/2026 09:17');
    expect(texte(nonSigne)).not.toContain('Gérald Incana');
    expect(nonSigne.subarray(0, 5).toString()).toBe('%PDF-');
    expect(signe.subarray(0, 5).toString()).toBe('%PDF-');
  });
  test('le contenu du BL (numéro, produits, totaux) est identique avec ou sans signature', async () => {
    const a = texte(await generatePDVDeliveryPDF(pdv, 'BL-0042', '10/11/2026', undefined, { compress: false }));
    const b = texte(await generatePDVDeliveryPDF(pdv, 'BL-0042', '10/11/2026', sigs, { compress: false }));
    for (const mot of ['BL-0042', 'Produit 1', 'Produit 5', 'SIGNATURE TRANSPORTEUR', 'SIGNATURE DESTINATAIRE', 'TOTAUX']) {
      expect(a).toContain(mot); expect(b).toContain(mot);
    }
  });
  test('signature partielle : seule celle recueillie apparaît ; le PDF reste valable avec beaucoup de lignes (2 pages)', async () => {
    const grand = { ...pdv, items: Array.from({ length: 60 }, (_, i) => ({ product_name: `Article ${i}`, quantity: 2, units_per_carton: 12 })) };
    const partiel = await generatePDVDeliveryPDF(grand, 'BL-0043', '10/11/2026', { transporteur: sigs.transporteur }, { compress: false });
    expect(images(partiel)).toBeGreaterThanOrEqual(1);
    expect(texte(partiel)).toContain('Gérald Incana');
    expect(texte(partiel)).not.toContain('Paul Destinataire');
    expect((partiel.toString('latin1').match(/\/Type \/Page\b/g) ?? []).length).toBeGreaterThanOrEqual(2);
  });
  test('une image illisible ne casse pas la génération du BL', async () => {
    const pdf = await generatePDVDeliveryPDF(pdv, 'BL-0044', '10/11/2026', { transporteur: { data: 'data:image/png;base64,AAAA', nom: 'X', dateLabel: 'd' } });
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
  });
});

test.describe('Contrôles de code : accès et preuve non modifiable', () => {
  const lire = (f: string) => readFileSync(f, 'utf8');
  const index = lire('src/pages/api/admin/bl-signatures/index.ts');
  const annuler = lire('src/pages/api/admin/bl-signatures/[id]/annuler.ts');
  const signe = lire('src/pages/api/delivery-notes/[id]/signe.ts');
  const middleware = lire('src/middleware.ts');

  test('seuls trois fichiers de src touchent la table (serveur) ; aucun suppression nulle part', () => {
    const f = execSync('git grep --untracked -l -F "from(\'bl_signatures\')" -- src', { encoding: 'utf8' }).split('\n').filter(Boolean).sort();
    expect(f).toEqual(['src/lib/blSignatures.ts', 'src/pages/api/admin/bl-signatures/[id]/annuler.ts', 'src/pages/api/admin/bl-signatures/index.ts', 'src/pages/api/admin/clients/[id]/delete.ts']);
    // la suppression d'un client ne fait que LIRE la table (pour refuser si des BL sont signés)
    const garde = lire('src/pages/api/admin/clients/[id]/delete.ts');
    expect(garde).toMatch(/from\('bl_signatures'\)\s*\.select\(/);
    expect(garde.indexOf('bl_signes')).toBeLessThan(garde.indexOf("from('orders').delete"));   // avant toute suppression
    for (const f2 of f) expect(lire(f2)).not.toMatch(/from\('bl_signatures'\)\s*\.delete\(/);
  });
  test('la seule écriture après création est l\'annulation (route admin) : aucun update ailleurs', () => {
    expect(index).not.toMatch(/\.update\(|\.delete\(|\.upsert\(/);
    const lib = lire('src/lib/blSignatures.ts');
    expect(lib).not.toMatch(/\.update\(|\.upsert\(/);
    expect(lib).not.toMatch(/from\('bl_signatures'\)\s*\.(delete|update|upsert)\(/);   // jamais sur les signatures
    expect(lib.match(/\.delete\(\)/g)).toHaveLength(1);                                // seul retrait : les lignes delivery_notes d'un lot raté…
    expect(lib).toMatch(/from\('delivery_notes'\)\.delete\(\)\.in\('delivery_id'/);    // …par numéro de BL, avant tout e-mail
    const maj = annuler.slice(annuler.indexOf('.update('), annuler.indexOf('.update(') + 200);
    expect(maj).toMatch(/annulee_le.*annulee_par.*annulation_motif/s);
    expect(maj).not.toMatch(/signature_data|signataire_nom|signed_by|signed_at/);
  });
  test('annulation : administrateur uniquement, motif obligatoire, journalisée, jamais une suppression', () => {
    expect(annuler).toMatch(/isAdmin\(user\)/);
    expect(annuler.indexOf('isAdmin(user)')).toBeLessThan(annuler.indexOf('.update('));
    expect(annuler).toMatch(/motif\.length < 3/);
    // la trace est écrite par la base (trigger), pas par l'application : voir bl-signatures-audit.spec.ts
    const sql = readFileSync('supabase/migrations/bl_signatures.sql', 'utf8');
    expect(sql).toContain("'bl.signature_annulee'");
    expect(annuler).not.toMatch(/logAdminAction/);
  });
  test('signature : journalisée, signataire et date jamais pris dans la requête du navigateur', () => {
    expect(readFileSync('supabase/migrations/bl_signatures.sql', 'utf8')).toMatch(/AFTER INSERT OR UPDATE ON bl_signatures[\s\S]*bl_signatures_journal/);
    expect(index).not.toMatch(/logAdminAction/);   // une seule trace, écrite par la base dans la même transaction
    expect(index).toMatch(/signed_by: user\.email/);
    expect(index).not.toMatch(/corps\??\.(signed_by|signed_at|annulee)/);
    expect(index).toMatch(/validerImageSignature\(corps\?\.signature_data\)/);
  });
  test('/api/admin est réservé au personnel par le middleware (admin et commercial) ; la page de signature est sous /admin', () => {
    expect(middleware).toMatch(/path\.startsWith\('\/api\/admin'\)/);
    expect(middleware).toMatch(/!isStaff\(user\)/);
  });
  test('le client ne peut qu\'obtenir SON bon signé en lecture ; aucune route de signature côté client', () => {
    expect(signe).toMatch(/isClientRole\(user\)/);
    expect(signe).toMatch(/client_id !== account\.id/);
    expect(signe).not.toMatch(/\.insert\(|\.update\(/);
    const f = execSync('git ls-files --others --cached "src/pages/**/*.ts" "src/pages/**/*.astro"', { encoding: 'utf8' }).split('\n').filter(Boolean);
    const clientSigne = f.filter(p => !p.includes('/admin/') && /sign/i.test(p));
    expect(clientSigne).toEqual(['src/pages/api/delivery-notes/[id]/signe.ts']);
  });
  test('le BL non signé reste servi par la route existante, inchangée', () => {
    expect(execSync('git diff --name-only', { encoding: 'utf8' })).not.toContain('delivery-notes/[id]/download.ts');
  });
  test('enregistrement immédiat sans réussite simulée : « enregistrée » n\'est affiché qu\'après la réponse ok du serveur', () => {
    const js = lire('public/js/signer-bl.js');
    const avant = js.slice(0, js.indexOf('function reussi'));
    expect(avant).not.toMatch(/enregistrée<\/p>/);
    expect(js).toMatch(/rep\.ok && j && j\.ok/);
    expect(js).toMatch(/Signature NON enregistrée/);
    expect(js).toMatch(/localStorage\.setItem/);
  });
  test('les identifiants utilisés par le script existent dans la page', () => {
    const js = lire('public/js/signer-bl.js'), page = lire('src/pages/admin/bl/[id]/signer.astro');
    for (const m of js.matchAll(/\$\('([a-z-]+)'\)/g)) {
      if (['sg-reessayer', 'sg-suite'].includes(m[1])) continue;   // créés dynamiquement
      expect(page, m[1]).toContain(`id="${m[1]}"`);
    }
  });
});
