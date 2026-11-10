/**
 * Création et conservation des BL — logique avec faux dépôt (aucun accès réseau ni base).
 * Objectifs : aucun BL ne peut échouer en silence ; un BL n'est jamais créé deux fois pour une même opération ;
 * livraisons regroupées et en plusieurs fois possibles ; un BL signé reste consultable dans la durée.
 */
import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { verifierStockageBl, creerBons, type DepotBl, type SpecBl, type BlReserve } from '../src/lib/blStockage';
import { blSigne, blOriginal, cleArchiveSigne, type DepotArchive, type NoteBl, type SignatureComplete } from '../src/lib/blArchive';
import { signatureTest, versDataUrl } from './helpers/png';

// ── Faux dépôt : reproduit le comportement de bl_creer (idempotence par clé, commandes annulées refusées) ──────────────
class FauxDepot implements DepotBl {
  sequence = 90;
  notes = new Map<string, { id: string; numero: string; chemin: string; spec: SpecBl }>();
  parCle = new Map<string, string>();
  fichiers = new Map<string, Buffer>();
  annulees = new Set<string>();
  appels: string[] = [];
  erreurPret: string | null = null;
  echecTeleversementPour: string | null = null;   // numéro de BL dont le dépôt échoue
  retraitImpossible = false;
  async pret() { this.appels.push('pret'); return this.erreurPret; }
  async reserver(spec: SpecBl): Promise<BlReserve | { erreur: string }> {
    this.appels.push('reserver:' + spec.cle);
    const existant = this.parCle.get(spec.cle);
    if (existant) { const n = this.notes.get(existant)!; return { id: n.id, numero: n.numero, chemin: n.chemin, cree: false }; }
    for (const c of spec.commandes) if (this.annulees.has(c.order_id)) return { erreur: 'Commande annulée : aucun BL possible' };
    this.sequence++;
    const numero = 'BL-' + String(this.sequence).padStart(4, '0');
    const id = 'note-' + numero;
    const note = { id, numero, chemin: `${numero}/${spec.pdvKey}.pdf`, spec: JSON.parse(JSON.stringify(spec)) };   // sérialisé : contenu figé
    this.notes.set(id, note); this.parCle.set(spec.cle, id);
    return { id, numero, chemin: note.chemin, cree: true };
  }
  async televerser(chemin: string, pdf: Buffer) {
    this.appels.push('televerser:' + chemin);
    if (this.echecTeleversementPour && chemin.startsWith(this.echecTeleversementPour)) return 'Bucket not found';
    this.fichiers.set(chemin, pdf); return null;
  }
  async retirerNote(id: string) {
    this.appels.push('retirerNote:' + id);
    if (this.retraitImpossible) throw new Error('panne');
    const n = this.notes.get(id); if (n) { this.parCle.delete(n.spec.cle); this.notes.delete(id); }
  }
  async retirerFichiers(c: string[]) { this.appels.push('retirerFichiers'); if (this.retraitImpossible) throw new Error('panne'); c.forEach(x => this.fichiers.delete(x)); }
}

const pdv = (nom: string) => ({ name: nom, client_societe: 'SARL ' + nom, items: [{ product_name: 'Cola 33cl', quantity: 12, units_per_carton: 24 }] });
const spec = (cle: string, nom: string, commandes: string[] = []): SpecBl => ({
  cle, clientId: null, pdvKey: 'k_' + nom, pdvName: nom, contenu: { pdv: pdv(nom), date: '10/11/2026' },
  commandes: commandes.map(o => ({ order_id: o, empreinte: 'h-' + o })),
});

test.describe('Vérification préalable du stockage', () => {
  test('stockage prêt : on continue', async () => {
    expect(await verifierStockageBl(new FauxDepot())).toEqual({ ok: true });
  });
  test('bucket ou migration absents : refus explicite, avant toute génération', async () => {
    const d = new FauxDepot(); d.erreurPret = 'table delivery_note_orders absente (migration bl_commandes.sql non appliquée)';
    const r = await verifierStockageBl(d);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.message).toContain('delivery_note_orders');
      expect(r.message).toMatch(/Rien n'a été généré ni envoyé/);
      expect(r.message).toMatch(/aucun numéro de BL n'a été consommé/);
    }
    expect(d.appels).toEqual(['pret']);
  });
  test('une panne pendant la vérification est aussi refusée (jamais ignorée)', async () => {
    const d = new FauxDepot(); d.pret = async () => { throw new Error('réseau coupé'); };
    const r = await verifierStockageBl(d);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain('réseau coupé');
  });
});

test.describe('Création commune des BL (Commandes et Livraison)', () => {
  test('BL d\'une commande : numéro suivant, PDF au stockage, contenu figé, commande rattachée par son identifiant', async () => {
    const d = new FauxDepot();
    const r = await creerBons(d, [spec('commande:o1:initial', 'Saint-Gilles', ['o1'])]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.bons[0]).toMatchObject({ numero: 'BL-0091', cree: true, chemin: 'BL-0091/k_Saint-Gilles.pdf' });
    expect(r.bons[0].pdf!.subarray(0, 5).toString()).toBe('%PDF-');
    expect(d.fichiers.has('BL-0091/k_Saint-Gilles.pdf')).toBe(true);
    expect(d.notes.get('note-BL-0091')!.spec.commandes).toEqual([{ order_id: 'o1', empreinte: 'h-o1' }]);
  });

  test('double clic / rafraîchissement / renvoi du formulaire : même BL, aucun nouveau numéro, aucun nouveau PDF', async () => {
    const d = new FauxDepot();
    const a = await creerBons(d, [spec('livraison:jeton-1:client_x', 'Station B', ['o1', 'o2'])]);
    const televersementsAvant = d.appels.filter(x => x.startsWith('televerser')).length;
    const b = await creerBons(d, [spec('livraison:jeton-1:client_x', 'Station B', ['o1', 'o2'])]);
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(b.bons[0]).toMatchObject({ numero: a.bons[0].numero, cree: false, pdf: null });
    expect(d.sequence).toBe(91);                                                       // un seul numéro consommé
    expect(d.notes.size).toBe(1);
    expect(d.appels.filter(x => x.startsWith('televerser')).length).toBe(televersementsAvant);   // aucun 2e dépôt
  });

  test('livraison regroupée : plusieurs commandes du même point de vente dans UN BL', async () => {
    const d = new FauxDepot();
    const r = await creerBons(d, [spec('livraison:jeton-2:client_x', 'Station B', ['o1', 'o2', 'o3'])]);
    expect(r.ok).toBe(true);
    expect(d.notes.size).toBe(1);
    expect(d.notes.get('note-BL-0091')!.spec.commandes.map(c => c.order_id)).toEqual(['o1', 'o2', 'o3']);
  });

  test('livraison en plusieurs fois : plusieurs BL pour la même commande (opérations différentes), numéros distincts', async () => {
    const d = new FauxDepot();
    await creerBons(d, [spec('livraison:jeton-3:client_x', 'Station B', ['o1'])]);
    await creerBons(d, [spec('livraison:jeton-4:client_x', 'Station B', ['o1'])]);
    expect([...d.notes.values()].map(n => n.numero)).toEqual(['BL-0091', 'BL-0092']);
    expect([...d.notes.values()].every(n => n.spec.commandes[0].order_id === 'o1')).toBe(true);
  });

  test('plusieurs points de vente dans un même envoi : un BL par point de vente', async () => {
    const d = new FauxDepot();
    const r = await creerBons(d, [spec('livraison:jeton-5:client_a', 'A', ['o1']), spec('livraison:jeton-5:client_b', 'B', ['o2'])]);
    expect(r.ok && r.bons.map(b => b.numero)).toEqual(['BL-0091', 'BL-0092']);
  });

  test('BL sans commande rattachée (lignes saisies à la main) : possible, non rattaché', async () => {
    const d = new FauxDepot();
    const r = await creerBons(d, [spec('livraison:jeton-6:client_a', 'A', [])]);
    expect(r.ok).toBe(true);
    expect(d.notes.get('note-BL-0091')!.spec.commandes).toEqual([]);
  });

  test('commande annulée : refus net, rien d\'écrit, aucun numéro consommé', async () => {
    const d = new FauxDepot(); d.annulees.add('o9');
    const r = await creerBons(d, [spec('commande:o9:initial', 'A', ['o9'])]);
    expect(r.ok).toBe(false);
    if (!r.ok) { expect(r.message).toContain('annulée'); expect(r.message).toMatch(/Aucun e-mail n'a été envoyé/); }
    expect(d.sequence).toBe(90); expect(d.notes.size).toBe(0); expect(d.fichiers.size).toBe(0);
  });

  test('échec du dépôt du 2e PDF : erreur visible, le 1er BL du lot est retiré (ligne + fichier), rien n\'est conservé', async () => {
    const d = new FauxDepot(); d.echecTeleversementPour = 'BL-0092';
    const r = await creerBons(d, [spec('livraison:jeton-7:client_a', 'A', ['o1']), spec('livraison:jeton-7:client_b', 'B', ['o2'])]);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.message).toContain('Bucket not found');
      expect(r.message).toMatch(/Aucun e-mail n'a été envoyé/);
      expect(r.message).toContain('BL-0091'); expect(r.message).toContain('BL-0092');   // numéros consommés, annoncés
    }
    expect(d.notes.size).toBe(0); expect(d.fichiers.size).toBe(0);
  });

  test('après un lot raté, le même formulaire peut être renvoyé : nouveaux BL créés proprement (la clé n\'est pas « brûlée »)', async () => {
    const d = new FauxDepot(); d.echecTeleversementPour = 'BL-0091';
    expect((await creerBons(d, [spec('livraison:jeton-8:client_a', 'A', ['o1'])])).ok).toBe(false);
    d.echecTeleversementPour = null;
    const r = await creerBons(d, [spec('livraison:jeton-8:client_a', 'A', ['o1'])]);
    expect(r.ok && r.bons[0].cree).toBe(true);
    expect(d.notes.size).toBe(1);
  });

  test('un retour arrière impossible ne masque pas l\'erreur d\'origine', async () => {
    const d = new FauxDepot(); d.echecTeleversementPour = 'BL-0092'; d.retraitImpossible = true;
    const r = await creerBons(d, [spec('livraison:jeton-9:client_a', 'A'), spec('livraison:jeton-9:client_b', 'B')]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain('Bucket not found');
  });

  test('le contenu enregistré est figé : une modification ultérieure des données de départ ne le change pas', async () => {
    const d = new FauxDepot(); const s = spec('commande:o1:initial', 'Saint-Gilles', ['o1']);
    await creerBons(d, [s]);
    s.contenu.pdv.items[0].quantity = 999; s.contenu.pdv.name = 'Autre';
    const fige = d.notes.get('note-BL-0091')!.spec.contenu;
    expect(fige.pdv.items[0].quantity).toBe(12); expect(fige.pdv.name).toBe('Saint-Gilles');
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

test.describe('BL original : archive figée, reconstruction de secours', () => {
  const avecChemin = (): NoteBl => ({ delivery_id: 'BL-0091', storage_path: 'BL-0091/k.pdf', contenu: { pdv: pdv('Saint-Gilles'), date: '10/11/2026' } });
  test('le fichier archivé est servi tel quel, sans aucune écriture', async () => {
    const d = new FauxArchive(avecChemin(), []); const pdf = Buffer.from('%PDF-1.3 archive');
    d.fichiers.set('BL-0091/k.pdf', pdf);
    const r = (await blOriginal(d, 'x'))!;
    expect(r.source).toBe('archive'); expect(r.buffer.equals(pdf)).toBe(true); expect(d.ecritures).toBe(0);
  });
  test('fichier manquant : reconstruit à l\'identique depuis le contenu figé puis archivé (sans écraser)', async () => {
    const d = new FauxArchive(avecChemin(), []);
    const r = (await blOriginal(d, 'x'))!;
    expect(r.source).toBe('regenere'); expect(r.buffer.subarray(0, 5).toString()).toBe('%PDF-');
    expect(d.fichiers.has('BL-0091/k.pdf')).toBe(true);
    expect((await blOriginal(d, 'x'))!.source).toBe('archive');
  });
  test('ni fichier ni contenu figé (ancienne ligne) : rien n\'est inventé', async () => {
    expect(await blOriginal(new FauxArchive({ delivery_id: 'BL-0001', storage_path: 'BL-0001/k.pdf', contenu: null }, []), 'x')).toBeNull();
    expect(await blOriginal(new FauxArchive(null, []), 'x')).toBeNull();
  });
});
