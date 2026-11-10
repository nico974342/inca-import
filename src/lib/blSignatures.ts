import { supabaseAdmin } from './supabase';
import { formatDateTimeReunion } from './datetime';
import { etatSignature, type EtatSignature, type RoleSignature } from './signatureBl';
import { blSigne, blOriginal, type BlSigne, type DepotArchive } from './blArchive';
import { BUCKET_BL, type DepotBl, type SpecBl } from './blStockage';
import { empreinteCommande, type LigneCommande } from './blCommande';

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

// ── BL rattachés aux commandes (identifiants de commandes, jamais l'e-mail) ──────────────────────────────────────────
export interface BlDeCommande {
  id: string;
  numero: string;
  pdv: string;
  cree_le: string;
  /** Faux = ancienne ligne sans contenu figé : consultable, mais pas signable ici. */
  signable: boolean;
  empreinte_commande: string;
  /** Nombre de commandes rattachées à ce BL (BL regroupé si > 1). */
  nb_commandes: number;
  signatures: SignatureResume[];
}

/** Pour chaque commande affichée : ses BL (plusieurs si livraison en plusieurs fois), du plus récent au plus ancien. */
export async function fetchBlsDesCommandes(orderIds: string[]): Promise<Map<string, BlDeCommande[]>> {
  const parCommande = new Map<string, BlDeCommande[]>();
  if (orderIds.length === 0) return parCommande;
  const { data, error } = await supabaseAdmin
    .from('delivery_note_orders')
    .select('order_id, empreinte_commande, delivery_notes(id, delivery_id, pdv_name, created_at, contenu_date:contenu->>date)')
    .in('order_id', orderIds);
  if (error) {
    // Migration pas encore appliquée : aucune liaison, la page Commandes garde son affichage actuel.
    console.error('[delivery_note_orders] lecture:', error.message);
    return parCommande;
  }
  const lignes = (data ?? []) as any[];
  const noteIds = [...new Set(lignes.map(l => l.delivery_notes?.id).filter(Boolean))] as string[];
  const [signatures, comptes] = await Promise.all([fetchSignaturesActives(noteIds), compterCommandesParBl(noteIds)]);
  for (const l of lignes) {
    const n = l.delivery_notes; if (!n) continue;
    const bl: BlDeCommande = {
      id: n.id, numero: n.delivery_id, pdv: n.pdv_name, cree_le: n.created_at, signable: !!n.contenu_date,
      empreinte_commande: l.empreinte_commande, nb_commandes: comptes.get(n.id) ?? 1, signatures: signatures.get(n.id) ?? [],
    };
    const liste = parCommande.get(l.order_id) ?? []; liste.push(bl); parCommande.set(l.order_id, liste);
  }
  for (const liste of parCommande.values()) liste.sort((a, b) => b.cree_le.localeCompare(a.cree_le));
  return parCommande;
}

async function compterCommandesParBl(noteIds: string[]): Promise<Map<string, number>> {
  const m = new Map<string, number>();
  if (noteIds.length === 0) return m;
  const { data } = await supabaseAdmin.from('delivery_note_orders').select('delivery_note_id').in('delivery_note_id', noteIds);
  for (const r of (data ?? []) as { delivery_note_id: string }[]) m.set(r.delivery_note_id, (m.get(r.delivery_note_id) ?? 0) + 1);
  return m;
}

/** Empreintes actuelles des lignes de commandes (pour comparer à celles figées à l'émission du BL). */
export async function fetchEmpreintesCommandes(orderIds: string[]): Promise<Map<string, string>> {
  const m = new Map<string, string>();
  if (orderIds.length === 0) return m;
  const { data } = await supabaseAdmin
    .from('order_items')
    .select('order_id, product_name, quantity, unit, price_ht_snapshot, tva_rate_snapshot')
    .in('order_id', orderIds);
  const parCommande = new Map<string, LigneCommande[]>();
  for (const r of (data ?? []) as any[]) { const l = parCommande.get(r.order_id) ?? []; l.push(r); parCommande.set(r.order_id, l); }
  for (const id of orderIds) m.set(id, empreinteCommande(parCommande.get(id) ?? []));
  return m;
}

/** Propriétaires (compte) des commandes liées à des BL : sert aux droits de consultation d'un client. */
export async function fetchLiensBl(noteIds: string[]): Promise<Map<string, { order_id: string; user_id: string | null }[]>> {
  const m = new Map<string, { order_id: string; user_id: string | null }[]>();
  if (noteIds.length === 0) return m;
  const { data, error } = await supabaseAdmin
    .from('delivery_note_orders').select('delivery_note_id, order_id, orders(user_id)').in('delivery_note_id', noteIds);
  if (error) { console.error('[delivery_note_orders] lecture:', error.message); return m; }
  for (const r of (data ?? []) as any[]) {
    const l = m.get(r.delivery_note_id) ?? []; l.push({ order_id: r.order_id, user_id: r.orders?.user_id ?? null }); m.set(r.delivery_note_id, l);
  }
  return m;
}

// ── Branchements Supabase des dépôts (la logique est dans blStockage.ts et blArchive.ts, testée hors ligne) ──
const dejaPresent = (e: { message?: string; statusCode?: string | number } | null) =>
  !!e && (String(e.statusCode) === '409' || /already exists|Duplicate/i.test(e.message ?? ''));

export const depotBl: DepotBl = {
  async pret() {
    const { error: eb } = await supabaseAdmin.storage.getBucket(BUCKET_BL);
    if (eb) return `bucket « ${BUCKET_BL} » introuvable`;
    const { error: ec } = await supabaseAdmin.from('delivery_notes').select('contenu, cle_operation').limit(1);
    if (ec) return 'colonnes delivery_notes.contenu / cle_operation absentes (migrations bl_signatures.sql et bl_commandes.sql à appliquer)';
    const { error: es } = await supabaseAdmin.from('bl_signatures').select('id').limit(1);
    if (es) return 'table bl_signatures absente (migration bl_signatures.sql non appliquée)';
    const { error: el } = await supabaseAdmin.from('delivery_note_orders').select('order_id').limit(1);
    if (el) return 'table delivery_note_orders absente (migration bl_commandes.sql non appliquée)';
    return null;
  },
  async reserver(spec: SpecBl) {
    const { data, error } = await supabaseAdmin.rpc('bl_creer', {
      p_cle: spec.cle, p_client_id: spec.clientId, p_pdv_key: spec.pdvKey, p_pdv_name: spec.pdvName,
      p_contenu: spec.contenu as any, p_commandes: spec.commandes as any,
    });
    if (error) return { erreur: error.message };
    const r = (Array.isArray(data) ? data[0] : data) as { bl_id: string; bl_numero: string; bl_chemin: string; bl_cree: boolean } | undefined;
    if (!r) return { erreur: 'réponse vide de bl_creer' };
    return { id: r.bl_id, numero: r.bl_numero, chemin: r.bl_chemin, cree: r.bl_cree };
  },
  async televerser(chemin, pdf) {
    const { error } = await supabaseAdmin.storage.from(BUCKET_BL).upload(chemin, pdf, { contentType: 'application/pdf', upsert: false });
    return error ? error.message : null;
  },
  async retirerNote(id) {
    // BL tout neuf, non signé, créé dans le lot qui a échoué : ses liaisons partent avec lui (cascade).
    await supabaseAdmin.from('delivery_notes').delete().eq('id', id);
  },
  async retirerFichiers(chemins) {
    if (chemins.length) await supabaseAdmin.storage.from(BUCKET_BL).remove(chemins);
  },
};

const depotArchive: DepotArchive = {
  async lireNote(noteId) {
    const { data } = await supabaseAdmin.from('delivery_notes').select('delivery_id, contenu, storage_path').eq('id', noteId).maybeSingle();
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
/** BL original non signé (archive du stockage, sinon reconstruit à l'identique depuis le contenu figé). */
export const lireBlOriginal = (noteId: string): Promise<BlSigne | null> => blOriginal(depotArchive, noteId);
