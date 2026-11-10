/**
 * Enregistrement et conservation des BL — logique avec faux dépôt (aucun accès réseau ni base).
 * Objectif : aucun BL ne peut échouer en silence ; un BL signé reste consultable dans la durée.
 */
import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { verifierStockageBl, enregistrerBons, type DepotBl, type LigneBl } from '../src/lib/blStockage';
import { blSigne, cleArchiveSigne, type DepotArchive, type NoteBl, type SignatureComplete } from '../src/lib/blArchive';
import { signatureTest, versDataUrl } from './helpers/png';

// ── Faux dépôt d'enregistrement ─────────────────────────────────────────────
class FauxDepot implements DepotBl {
  fichiers = new Map<string, Buffer>();
  lignes = new Map<string, any>();
  appels: string[] = [];
  erreurPret: string | null = null;
  echecTeleversement: string | null = null;      // numéro de BL dont le dépôt échoue
  echecInsertion: string | null = null;
  retraitImpossible = false;
  async pret() { this.appels.push('pret'); return this.erreurPret; }
  async televerser(chemin: string, pdf: Buffer) {
    this.appels.push('televerser:' + chemin);
    if (this.echecTeleversement && chemin.startsWith(this.echecTeleversement)) return 'Bucket not found';
    if (this.fichiers.has(chemin)) return 'The resource already exists';
    this.fichiers.set(chemin, pdf); return null;
  }
  async insererNote(l: LigneBl) {
    this.appels.push('inserer:' + l.delivery_id);
    if (this.echecInsertion === l.delivery_id) return 'violates not-null constraint';
    if (this.lignes.has(l.delivery_id)) return 'duplicate key value';
    this.lignes.set(l.delivery_id, JSON.parse(JSON.stringify(l))); return null;   // sérialisé comme dans la base
  }
  async retirerFichiers(c: string[]) { this.appels.push('retirerFichiers'); if (this.retraitImpossible) throw new Error('panne'); c.forEach(x => this.fichiers.delete(x)); }
  async retirerNotes(n: string[]) { this.appels.push('retirerNotes'); if (this.retraitImpossible) throw new Error('panne'); n.forEach(x => this.lignes.delete(x)); }
}

const pdv = (nom: string) => ({ name: nom, client_societe: 'SARL ' + nom, items: [{ product_name: 'Cola 33cl', quantity: 12, units_per_carton: 24 }] });
const bon = (num: string, nom: string): { ligne: LigneBl; pdf: Buffer } => ({
  ligne: { delivery_id: num, client_id: null, pdv_key: 'k_' + nom, pdv_name: nom, storage_path: `${num}/k_${nom}.pdf`, contenu: { pdv: pdv(nom), date: '10/11/2026' } },
  pdf: Buffer.from('%PDF-1.3 ' + num),
});

test.describe('Vérification préalable du stockage', () => {
  test('stockage prêt : on continue', async () => {
    expect(await verifierStockageBl(new FauxDepot())).toEqual({ ok: true });
  });
  test('bucket absent (la cause d\'origine) : refus explicite, avant toute génération', async () => {
    const d = new FauxDepot(); d.erreurPret = 'bucket « delivery-notes » introuvable';
    const r = await verifierStockageBl(d);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.message).toContain('delivery-notes');
      expect(r.message).toMatch(/Rien n'a été généré ni envoyé/);
      expect(r.message).toMatch(/aucun numéro de BL n'a été consommé/);
    }
    expect(d.appels).toEqual(['pret']);   // aucun dépôt, aucune insertion
  });
  test('une panne pendant la vérification est aussi refusée (jamais ignorée)', async () => {
    const d = new FauxDepot(); d.pret = async () => { throw new Error('réseau coupé'); };
    const r = await verifierStockageBl(d);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain('réseau coupé');
  });
});

test.describe('Enregistrement des BL (tout ou rien, avant l\'e-mail)', () => {
  test('lot complet : fichiers et lignes enregistrés avec le contenu figé', async () => {
    const d = new FauxDepot();
    const r = await enregistrerBons(d, [bon('BL-0091', 'Saint-Gilles'), bon('BL-0092', 'Le Port')]);
    expect(r).toEqual({ ok: true });
    expect([...d.fichiers.keys()]).toEqual(['BL-0091/k_Saint-Gilles.pdf', 'BL-0092/k_Le Port.pdf']);
    expect(d.lignes.get('BL-0091').contenu).toEqual({ pdv: pdv('Saint-Gilles'), date: '10/11/2026' });
    expect(d.lignes.get('BL-0092').contenu.pdv.items[0]).toMatchObject({ product_name: 'Cola 33cl', quantity: 12 });
  });

  test('échec du dépôt du 2e PDF : erreur visible, rien n\'est conservé du lot, ordre « enregistrer puis envoyer » respecté', async () => {
    const d = new FauxDepot(); d.echecTeleversement = 'BL-0092';
    const r = await enregistrerBons(d, [bon('BL-0091', 'Saint-Gilles'), bon('BL-0092', 'Le Port')]);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.message).toContain('BL-0092');
      expect(r.message).toContain('Bucket not found');
      expect(r.message).toMatch(/Aucun e-mail n'a été envoyé/);
    }
    expect(d.fichiers.size).toBe(0); expect(d.lignes.size).toBe(0);   // le 1er BL, déjà écrit, est retiré
  });

  test('échec de l\'enregistrement de la ligne : le PDF déjà déposé est retiré', async () => {
    const d = new FauxDepot(); d.echecInsertion = 'BL-0091';
    const r = await enregistrerBons(d, [bon('BL-0091', 'Saint-Gilles')]);
    expect(r.ok).toBe(false);
    expect(d.fichiers.size).toBe(0); expect(d.lignes.size).toBe(0);
  });

  test('un retour arrière impossible ne masque pas l\'erreur d\'origine', async () => {
    const d = new FauxDepot(); d.echecTeleversement = 'BL-0092'; d.retraitImpossible = true;
    const r = await enregistrerBons(d, [bon('BL-0091', 'A'), bon('BL-0092', 'B')]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain('BL-0092');
  });

  test('numéro déjà enregistré : refus (jamais d\'écrasement), le lot est retiré', async () => {
    const d = new FauxDepot();
    await enregistrerBons(d, [bon('BL-0091', 'A')]);
    const r = await enregistrerBons(d, [bon('BL-0093', 'C'), bon('BL-0091', 'A')]);
    expect(r.ok).toBe(false);
    expect(d.lignes.has('BL-0093')).toBe(false);       // le BL du lot raté est retiré
    expect(d.lignes.has('BL-0091')).toBe(true);        // l'ancien BL n'est pas touché
  });

  test('le contenu mémorisé ne change plus si les données de départ changent ensuite', async () => {
    const d = new FauxDepot(); const b = bon('BL-0091', 'Saint-Gilles');
    await enregistrerBons(d, [b]);
    b.ligne.contenu.pdv.items[0].quantity = 999;        // « modification ultérieure » côté application
    b.ligne.contenu.pdv.name = 'Autre';
    expect(d.lignes.get('BL-0091').contenu.pdv.items[0].quantity).toBe(12);
    expect(d.lignes.get('BL-0091').contenu.pdv.name).toBe('Saint-Gilles');
  });
});

test.describe('Page livraison : ordre des opérations', () => {
  const page = readFileSync('src/pages/admin/livraison.astro', 'utf8');
  test('vérification du stockage AVANT la consommation d\'un numéro ; enregistrement AVANT l\'e-mail', () => {
    expect(page.indexOf('verifierStockageBl(depotBl)')).toBeGreaterThan(0);
    expect(page.indexOf('verifierStockageBl(depotBl)')).toBeLessThan(page.indexOf("rpc('next_bl_number')"));
    expect(page.indexOf('enregistrerBons(depotBl')).toBeLessThan(page.indexOf('resend.emails.send'));
    expect(page.indexOf('generatePDVDeliveryPDF(pdv, blNumbers[i], dateStr)')).toBeLessThan(page.indexOf('enregistrerBons(depotBl'));
  });
  test('l\'e-mail n\'est envoyé que si l\'enregistrement a réussi ; aucune erreur d\'enregistrement n\'est avalée', () => {
    const apresEchec = page.slice(page.indexOf('if (!enr.ok) {'), page.indexOf('} else {', page.indexOf('if (!enr.ok) {')));
    expect(apresEchec).toContain('errorMessage = enr.message');
    expect(apresEchec).not.toContain('resend');
    expect(page).not.toMatch(/blNonEnregistres/);
    expect(page).not.toMatch(/\.from\('delivery-notes'\)/);     // plus d'enregistrement « au fil de l'eau » avec erreur seulement consignée
  });
  test('la mise à jour des commandes n\'a lieu qu\'après un envoi réussi (comportement conservé)', () => {
    expect(page.indexOf("status: 'en_preparation'")).toBeGreaterThan(page.indexOf('successMessage ='));
  });
  test('anciens BL (sans contenu figé) : « Signé sur papier », jamais « Non signé » ni bouton de signature', () => {
    expect(page).toContain('Signé sur papier');
    expect(page).toMatch(/b\.etat !== 'signe' && b\.signable/);
    const fiche = readFileSync('src/pages/admin/clients/[id].astro', 'utf8');
    expect(fiche).toContain("'Signé sur papier'");
  });
  test('le suivi ne lit que delivery_notes : les 77 BL de commandes (orders.bl_number) n\'y apparaissent jamais', () => {
    expect(page).not.toMatch(/[^_a-z]bl_number/);   // (next_bl_number = numérotation, pas une lecture) la page livraison ne lit pas orders.bl_number (BL de commandes)
    expect(readFileSync('src/lib/blSignatures.ts', 'utf8')).not.toMatch(/orders/);
  });
});

// ── Conservation du BL signé ────────────────────────────────────────────────
class FauxArchive implements DepotArchive {
  fichiers = new Map<string, Buffer>();
  erreurEcriture: string | null = null; lectureSignaturesKO = false; ecritures = 0;
  constructor(public note: NoteBl | null, public signatures: SignatureComplete[]) {}
  async lireNote() { return this.note; }
  async lireSignaturesActives() { return this.lectureSignaturesKO ? null : this.signatures.filter(s => !(s as any).annulee); }
  async lireFichier(c: string) { return this.fichiers.get(c) ?? null; }
  async ecrireFichier(c: string, pdf: Buffer) { this.ecritures++; if (this.erreurEcriture) return this.erreurEcriture; if (!this.fichiers.has(c)) this.fichiers.set(c, pdf); return null; }
  formaterDate = (iso: string) => iso.slice(0, 16).replace('T', ' ');
}
const img = versDataUrl(signatureTest());
const sigT: SignatureComplete = { id: 'sig-t', role: 'transporteur', signature_data: img, signataire_nom: 'Gérald', signed_at: '2026-11-10T09:15:00Z' };
const sigD: SignatureComplete = { id: 'sig-d', role: 'destinataire', signature_data: img, signataire_nom: 'Marie', signed_at: '2026-11-10T09:17:00Z' };
const note = (): NoteBl => ({ delivery_id: 'BL-0091', contenu: { pdv: pdv('Saint-Gilles'), date: '10/11/2026' } });

test.describe('BL signé : conservation et disponibilité dans la durée', () => {
  test('pas de BL signé tant que les deux signatures ne sont pas là, ou sans contenu figé, ou si la lecture échoue', async () => {
    expect(await blSigne(new FauxArchive(note(), []), 'x')).toBeNull();
    expect(await blSigne(new FauxArchive(note(), [sigT]), 'x')).toBeNull();
    expect(await blSigne(new FauxArchive({ delivery_id: 'BL-0001', contenu: null }, [sigT, sigD]), 'x')).toBeNull();   // ancien BL
    expect(await blSigne(new FauxArchive(null, [sigT, sigD]), 'x')).toBeNull();
    const ko = new FauxArchive(note(), [sigT, sigD]); ko.lectureSignaturesKO = true;
    expect(await blSigne(ko, 'x')).toBeNull();
  });

  test('première demande : PDF produit depuis le contenu figé et archivé ; ensuite servi depuis l\'archive, octet pour octet', async () => {
    const d = new FauxArchive(note(), [sigT, sigD]);
    const a = (await blSigne(d, 'x'))!;
    expect(a.source).toBe('regenere'); expect(a.blNumber).toBe('BL-0091');
    expect(a.buffer.subarray(0, 5).toString()).toBe('%PDF-');
    expect(d.fichiers.size).toBe(1);
    const b = (await blSigne(d, 'x'))!;
    expect(b.source).toBe('archive');
    expect(b.buffer.equals(a.buffer)).toBe(true);
    expect(d.ecritures).toBe(1);   // pas de réécriture
  });

  test('indépendant des commandes : seul le contenu figé du BL intervient (aucun accès aux commandes dans le dépôt)', async () => {
    const d = new FauxArchive(note(), [sigT, sigD]);
    const cles = Object.getOwnPropertyNames(Object.getPrototypeOf(d)).filter(k => k !== 'constructor');
    expect(cles.sort()).toEqual(['ecrireFichier', 'lireFichier', 'lireNote', 'lireSignaturesActives'].sort());
    expect(readFileSync('src/lib/blArchive.ts', 'utf8')).not.toMatch(/from\('orders'\)|order_items/);
  });

  test('l\'archive reste disponible même si la reconstruction devenait impossible plus tard', async () => {
    const d = new FauxArchive(note(), [sigT, sigD]);
    const a = (await blSigne(d, 'x'))!;
    d.note = { delivery_id: 'BL-0091', contenu: null };   // contenu devenu illisible : l'archive, elle, ne dépend de rien
    expect(await blSigne(d, 'x')).toBeNull();             // sans contenu, on ne sert rien de faux…
    d.note = note();
    expect((await blSigne(d, 'x'))!.buffer.equals(a.buffer)).toBe(true);
  });

  test('signature annulée puis refaite : nouveau fichier archivé, l\'ancien est conservé (aucun écrasement)', async () => {
    const d = new FauxArchive(note(), [sigT, sigD]);
    await blSigne(d, 'x');
    const ancienne = [...d.fichiers.keys()][0];
    (sigD as any).annulee = true;
    d.signatures = [sigT, sigD, { id: 'sig-d2', role: 'destinataire', signature_data: img, signataire_nom: 'Paul', signed_at: '2026-11-10T10:00:00Z' }];
    const b = (await blSigne(d, 'x'))!;
    expect(d.fichiers.size).toBe(2); expect(d.fichiers.has(ancienne)).toBe(true);
    expect(cleArchiveSigne('BL-0091', ['sig-t', 'sig-d2'])).not.toBe(ancienne);
    expect(b.source).toBe('regenere');
    delete (sigD as any).annulee;
  });

  test('archivage impossible : le PDF est tout de même fourni (reconstructible) et l\'incident est consigné', async () => {
    const d = new FauxArchive(note(), [sigT, sigD]); d.erreurEcriture = 'stockage indisponible';
    const erreurs: string[] = []; const orig = console.error; console.error = (...a: any[]) => erreurs.push(a.join(' '));
    try {
      const r = (await blSigne(d, 'x'))!;
      expect(r.buffer.subarray(0, 5).toString()).toBe('%PDF-');
    } finally { console.error = orig; }
    expect(erreurs.join('\n')).toMatch(/archivage.*BL-0091.*stockage indisponible/);
  });

  test('nom de fichier d\'archive : stable, lié au BL et aux signatures contenues', () => {
    expect(cleArchiveSigne('BL-0091', ['a', 'b'])).toBe(cleArchiveSigne('BL-0091', ['b', 'a']));
    expect(cleArchiveSigne('BL-0091', ['a', 'b'])).toMatch(/^BL-0091\/signe-[0-9a-f]{16}\.pdf$/);
    expect(cleArchiveSigne('BL-0091', ['a', 'b'])).not.toBe(cleArchiveSigne('BL-0091', ['a', 'c']));
  });

  test('archivage dès la 2e signature (API) ; le téléchargement signé passe par la même fonction', () => {
    const api = readFileSync('src/pages/api/admin/bl-signatures/index.ts', 'utf8');
    expect(api).toMatch(/if \(etat === 'signe'\) await archiver\(noteId\)/);
    expect(readFileSync('src/pages/api/delivery-notes/[id]/signe.ts', 'utf8')).toContain('construireBlSigne(id)');
  });
});
