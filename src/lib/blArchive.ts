/**
 * BL signé : PDF produit à partir du contenu FIGÉ du BL (delivery_notes.contenu) et des signatures conservées,
 * puis archivé dans le stockage. Il ne dépend jamais des commandes : modifier ou supprimer une commande
 * ne change rien à un BL établi. Logique pure (accès injectés), testée dans tests/bl-archive.spec.ts.
 *
 * Le fichier archivé est nommé d'après les signatures actives qu'il contient : si une signature est annulée puis
 * refaite, un nouveau fichier est créé et l'ancien reste (aucun écrasement, aucune perte).
 */
import { createHash } from 'node:crypto';
import { generatePDVDeliveryPDF, type BlSignaturesPdf, type DeliveryPDV } from './pdf';
import { ROLES_SIGNATURE, type RoleSignature } from './signatureBl';

export interface NoteBl { delivery_id: string; contenu: { pdv: DeliveryPDV; date: string } | null; storage_path?: string | null }
export interface SignatureComplete { id: string; role: string; signature_data: string; signataire_nom: string; signed_at: string }

export interface DepotArchive {
  lireNote(noteId: string): Promise<NoteBl | null>;
  /** Signatures actives (non annulées) ; null si la lecture a échoué. */
  lireSignaturesActives(noteId: string): Promise<SignatureComplete[] | null>;
  lireFichier(chemin: string): Promise<Buffer | null>;
  /** null = écrit (ou déjà présent) ; sinon message d'erreur. Ne remplace jamais un fichier existant. */
  ecrireFichier(chemin: string, pdf: Buffer): Promise<string | null>;
  formaterDate(iso: string): string;
}

export type SourceBl = 'archive' | 'regenere';
export interface BlSigne { buffer: Buffer; blNumber: string; source: SourceBl }

export const cleArchiveSigne = (blNumber: string, idsSignatures: string[]): string =>
  `${blNumber}/signe-${createHash('sha256').update([...idsSignatures].sort().join('|')).digest('hex').slice(0, 16)}.pdf`;

/**
 * Renvoie le BL signé (archive si elle existe, sinon reconstruction puis archivage). null si le BL n'est pas entièrement
 * signé, n'a pas de contenu figé, ou si la lecture a échoué. Un échec d'ARCHIVAGE n'empêche pas la livraison du PDF
 * (il est reconstructible à l'identique) : il est consigné dans les journaux du serveur.
 */
export async function blSigne(depot: DepotArchive, noteId: string): Promise<BlSigne | null> {
  const note = await depot.lireNote(noteId);
  if (!note?.contenu?.pdv || !note.contenu.date) return null;
  const lignes = await depot.lireSignaturesActives(noteId);
  if (!lignes) return null;

  const parRole = new Map<RoleSignature, SignatureComplete>();
  for (const l of lignes) if ((ROLES_SIGNATURE as readonly string[]).includes(l.role)) parRole.set(l.role as RoleSignature, l);
  const transporteur = parRole.get('transporteur'), destinataire = parRole.get('destinataire');
  if (!transporteur || !destinataire) return null;

  const cle = cleArchiveSigne(note.delivery_id, [transporteur.id, destinataire.id]);
  const archive = await depot.lireFichier(cle);
  if (archive) return { buffer: archive, blNumber: note.delivery_id, source: 'archive' };

  const signatures: BlSignaturesPdf = {};
  for (const l of [transporteur, destinataire]) {
    signatures[l.role as RoleSignature] = { data: l.signature_data, nom: l.signataire_nom, dateLabel: depot.formaterDate(l.signed_at) };
  }
  const buffer = await generatePDVDeliveryPDF(note.contenu.pdv, note.delivery_id, note.contenu.date, signatures);
  const erreur = await depot.ecrireFichier(cle, buffer).catch(e => (e instanceof Error ? e.message : String(e)));
  if (erreur) console.error(`[bl] archivage du BL signé ${note.delivery_id} impossible : ${erreur}`);
  return { buffer, blNumber: note.delivery_id, source: 'regenere' };
}

/**
 * BL ORIGINAL (non signé) : le fichier archivé à la création s'il existe, sinon reconstruit à l'identique depuis le contenu figé
 * puis archivé (jamais d'écrasement). null si ni fichier ni contenu figé (ancienne ligne : l'appelant garde son comportement historique).
 */
export async function blOriginal(depot: DepotArchive, noteId: string): Promise<BlSigne | null> {
  const note = await depot.lireNote(noteId);
  if (!note) return null;
  if (note.storage_path) {
    const archive = await depot.lireFichier(note.storage_path);
    if (archive) return { buffer: archive, blNumber: note.delivery_id, source: 'archive' };
  }
  if (!note.contenu?.pdv || !note.contenu.date) return null;
  const buffer = await generatePDVDeliveryPDF(note.contenu.pdv, note.delivery_id, note.contenu.date);
  if (note.storage_path) {
    const erreur = await depot.ecrireFichier(note.storage_path, buffer).catch(e => (e instanceof Error ? e.message : String(e)));
    if (erreur) console.error(`[bl] archivage du BL ${note.delivery_id} impossible : ${erreur}`);
  }
  return { buffer, blNumber: note.delivery_id, source: 'regenere' };
}
