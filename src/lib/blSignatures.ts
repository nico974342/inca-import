import { supabaseAdmin } from './supabase';
import { generatePDVDeliveryPDF, type BlSignaturesPdf, type DeliveryPDV } from './pdf';
import { formatDateTimeReunion } from './datetime';
import { etatSignature, ROLES_SIGNATURE, type EtatSignature, type RoleSignature } from './signatureBl';

/** Signature SANS l'image (listes, états) : l'image n'est lue que pour afficher ou produire le PDF. */
export interface SignatureResume {
  id: string;
  delivery_note_id: string;
  role: RoleSignature;
  signataire_nom: string;
  signed_at: string;
  signed_by: string;
  annulee_le: string | null;
}

/** Contenu du BL mémorisé à sa génération (delivery_notes.contenu). */
export interface ContenuBl { pdv: DeliveryPDV; date: string }

/** Signatures ACTIVES (non annulées) de plusieurs BL, regroupées par BL. */
export async function fetchSignaturesActives(noteIds: string[]): Promise<Map<string, SignatureResume[]>> {
  const parBl = new Map<string, SignatureResume[]>();
  if (noteIds.length === 0) return parBl;
  const { data, error } = await supabaseAdmin
    .from('bl_signatures')
    .select('id, delivery_note_id, role, signataire_nom, signed_at, signed_by, annulee_le')
    .in('delivery_note_id', noteIds)
    .is('annulee_le', null);
  if (error) {
    // Table absente (migration pas appliquée) ou erreur : aucun BL n'apparaît comme signé, rien ne casse.
    console.error('[bl_signatures] lecture:', error.message);
    return parBl;
  }
  for (const s of (data ?? []) as SignatureResume[]) {
    const l = parBl.get(s.delivery_note_id) ?? [];
    l.push(s); parBl.set(s.delivery_note_id, l);
  }
  return parBl;
}

export const etatDuBl = (signatures: SignatureResume[] | undefined): EtatSignature => etatSignature(signatures ?? []);

/**
 * PDF du BL avec les deux signatures intégrées, reproduit à l'identique depuis le contenu mémorisé.
 * Renvoie null si le BL n'est pas entièrement signé ou n'a pas de contenu mémorisé. Le PDF non signé stocké n'est jamais modifié.
 */
export async function construireBlSigne(noteId: string): Promise<{ buffer: Buffer; blNumber: string } | null> {
  const { data: note } = await supabaseAdmin
    .from('delivery_notes').select('id, delivery_id, contenu').eq('id', noteId).maybeSingle();
  const contenu = (note as any)?.contenu as ContenuBl | null | undefined;
  if (!note || !contenu?.pdv || !contenu.date) return null;

  const { data: lignes, error } = await supabaseAdmin
    .from('bl_signatures')
    .select('role, signature_data, signataire_nom, signed_at')
    .eq('delivery_note_id', noteId)
    .is('annulee_le', null);
  if (error || !lignes) return null;

  const signatures: BlSignaturesPdf = {};
  for (const l of lignes as any[]) {
    if ((ROLES_SIGNATURE as readonly string[]).includes(l.role)) {
      signatures[l.role as RoleSignature] = { data: l.signature_data, nom: l.signataire_nom, dateLabel: formatDateTimeReunion(l.signed_at) };
    }
  }
  if (!signatures.transporteur || !signatures.destinataire) return null;

  const blNumber = (note as any).delivery_id as string;
  return { buffer: await generatePDVDeliveryPDF(contenu.pdv, blNumber, contenu.date, signatures), blNumber };
}
