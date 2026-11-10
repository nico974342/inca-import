import { supabaseAdmin } from './supabase';
import { formatDateTimeReunion } from './datetime';
import { etatSignature, type EtatSignature, type RoleSignature } from './signatureBl';
import { blSigne, type BlSigne, type DepotArchive } from './blArchive';
import { BUCKET_BL, type DepotBl } from './blStockage';

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
export type { ContenuBl } from './blStockage';

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

// ── Branchements Supabase des dépôts (la logique est dans blStockage.ts et blArchive.ts, testée hors ligne) ──
const dejaPresent = (e: { message?: string; statusCode?: string | number } | null) =>
  !!e && (String(e.statusCode) === '409' || /already exists|Duplicate/i.test(e.message ?? ''));

export const depotBl: DepotBl = {
  async pret() {
    const { error: eb } = await supabaseAdmin.storage.getBucket(BUCKET_BL);
    if (eb) return `bucket « ${BUCKET_BL} » introuvable`;
    const { error: ec } = await supabaseAdmin.from('delivery_notes').select('contenu').limit(1);
    if (ec) return 'colonne delivery_notes.contenu absente (migration bl_signatures.sql non appliquée)';
    const { error: es } = await supabaseAdmin.from('bl_signatures').select('id').limit(1);
    if (es) return 'table bl_signatures absente (migration bl_signatures.sql non appliquée)';
    return null;
  },
  async televerser(chemin, pdf) {
    const { error } = await supabaseAdmin.storage.from(BUCKET_BL).upload(chemin, pdf, { contentType: 'application/pdf', upsert: false });
    return error ? error.message : null;
  },
  async insererNote(ligne) {
    const { error } = await supabaseAdmin.from('delivery_notes').insert(ligne);
    return error ? error.message : null;
  },
  async retirerFichiers(chemins) {
    if (chemins.length) await supabaseAdmin.storage.from(BUCKET_BL).remove(chemins);
  },
  async retirerNotes(numeros) {
    if (numeros.length) await supabaseAdmin.from('delivery_notes').delete().in('delivery_id', numeros);
  },
};

const depotArchive: DepotArchive = {
  async lireNote(noteId) {
    const { data } = await supabaseAdmin.from('delivery_notes').select('delivery_id, contenu').eq('id', noteId).maybeSingle();
    return (data as any) ?? null;
  },
  async lireSignaturesActives(noteId) {
    const { data, error } = await supabaseAdmin
      .from('bl_signatures')
      .select('id, role, signature_data, signataire_nom, signed_at')
      .eq('delivery_note_id', noteId)
      .is('annulee_le', null);
    return error ? null : ((data ?? []) as any[]);
  },
  async lireFichier(chemin) {
    const { data, error } = await supabaseAdmin.storage.from(BUCKET_BL).download(chemin);
    return error || !data ? null : Buffer.from(await data.arrayBuffer());
  },
  async ecrireFichier(chemin, pdf) {
    const { error } = await supabaseAdmin.storage.from(BUCKET_BL).upload(chemin, pdf, { contentType: 'application/pdf', upsert: false });
    return error && !dejaPresent(error as any) ? error.message : null;
  },
  formaterDate: iso => formatDateTimeReunion(iso),
};

/** BL signé (archive du stockage, sinon reconstruit à l'identique depuis le contenu figé, puis archivé). */
export const construireBlSigne = (noteId: string): Promise<BlSigne | null> => blSigne(depotArchive, noteId);
