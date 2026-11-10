/**
 * Création des bons de livraison — système COMMUN à Commandes et Livraison. Logique pure (accès injectés), testée hors ligne
 * dans tests/bl-stockage.spec.ts.
 *
 *   1. verifierStockageBl()  — avant de consommer le moindre numéro : le stockage et la migration sont-ils prêts ?
 *   2. creerBons()           — pour chaque BL : réservation ATOMIQUE et IDEMPOTENTE en base (numéro + ligne + contenu figé +
 *                              liaisons aux commandes, fonction bl_creer), puis PDF au stockage. Au premier échec, tout ce qui a
 *                              été créé dans ce lot est retiré et l'erreur est renvoyée : l'appelant n'envoie RIEN.
 * Une même clé d'opération renvoie le BL déjà créé (double clic, rafraîchissement) : aucun nouveau numéro, aucun nouveau PDF.
 */
import type { DeliveryPDV } from './pdf';
import { generatePDVDeliveryPDF } from './pdf';

export const BUCKET_BL = 'delivery-notes';

/** Le BL tel qu'il a été généré : permet de reproduire le PDF (signé ou non) à l'identique, indépendamment des commandes. */
export interface ContenuBl { pdv: DeliveryPDV; date: string }

export interface SpecBl {
  /** Clé d'opération : une même opération de livraison = une même clé = un seul BL. */
  cle: string;
  clientId: string | null;
  pdvKey: string;
  pdvName: string;
  contenu: ContenuBl;
  /** Commandes rattachées (identifiants réels) avec l'empreinte de leurs lignes à l'émission. Peut être vide (BL libre). */
  commandes: { order_id: string; empreinte: string }[];
}
export interface BlReserve { id: string; numero: string; chemin: string; cree: boolean }

/** Accès au stockage et à la base, injecté (Supabase en production, faux dépôt dans les tests). Une chaîne = message d'erreur. */
export interface DepotBl {
  /** Prêt ? (bucket, colonne « contenu », tables des signatures et des liaisons, fonction bl_creer). null = oui. */
  pret(): Promise<string | null>;
  reserver(spec: SpecBl): Promise<BlReserve | { erreur: string }>;
  televerser(chemin: string, pdf: Buffer): Promise<string | null>;
  /** Retire un BL NON signé créé dans ce lot (ses liaisons partent avec lui). */
  retirerNote(id: string): Promise<void>;
  retirerFichiers(chemins: string[]): Promise<void>;
}

export type ResultatBl = { ok: true } | { ok: false; message: string; detail?: string };
export interface BlCree extends BlReserve { cle: string; pdf: Buffer | null }
export type ResultatCreation = { ok: true; bons: BlCree[] } | { ok: false; message: string };

export async function verifierStockageBl(depot: Pick<DepotBl, 'pret'>): Promise<ResultatBl> {
  let erreur: string | null;
  try { erreur = await depot.pret(); } catch (e) { erreur = e instanceof Error ? e.message : String(e); }
  if (!erreur) return { ok: true };
  return {
    ok: false,
    message: `Le stockage des bons de livraison n'est pas prêt (${erreur}). Rien n'a été généré ni envoyé, aucun numéro de BL n'a été consommé. Prévenez le support avant de réessayer.`,
    detail: erreur,
  };
}

export const genererPdfBl = (contenu: ContenuBl, numero: string): Promise<Buffer> =>
  generatePDVDeliveryPDF(contenu.pdv, numero, contenu.date);

export async function creerBons(depot: DepotBl, specs: SpecBl[]): Promise<ResultatCreation> {
  const crees: { id: string; numero: string }[] = [];
  const fichiers: string[] = [];
  const bons: BlCree[] = [];
  const echec = async (quoi: string, detail: string): Promise<ResultatCreation> => {
    // Retour arrière : seuls les BL créés dans CE lot (non signés, tout neufs) et leurs fichiers sont retirés.
    for (const c of crees) { try { await depot.retirerNote(c.id); } catch (e) { console.error('[bl] retrait du BL impossible', c.numero, e); } }
    try { await depot.retirerFichiers(fichiers); } catch (e) { console.error('[bl] retrait des fichiers impossible', e); }
    const numeros = crees.map(c => c.numero);
    return {
      ok: false,
      message: `Le bon de livraison n'a pas pu être enregistré (${quoi} : ${detail}). Aucun e-mail n'a été envoyé et aucun bon de ce lot n'est conservé.` +
        (numeros.length ? ` Numéros consommés, inutilisés : ${numeros.join(', ')}.` : ''),
    };
  };

  for (const spec of specs) {
    let r: BlReserve | { erreur: string };
    try { r = await depot.reserver(spec); } catch (e) { r = { erreur: e instanceof Error ? e.message : String(e) }; }
    if ('erreur' in r) return echec('réservation', r.erreur);

    if (!r.cree) { bons.push({ ...r, cle: spec.cle, pdf: null }); continue; }   // déjà créé par une demande précédente : rien à refaire
    crees.push({ id: r.id, numero: r.numero });

    let pdf: Buffer;
    try { pdf = await genererPdfBl(spec.contenu, r.numero); } catch (e) { return echec('génération du PDF', e instanceof Error ? e.message : String(e)); }
    let e: string | null;
    try { e = await depot.televerser(r.chemin, pdf); } catch (x) { e = x instanceof Error ? x.message : String(x); }
    if (e) return echec('stockage du PDF', e);
    fichiers.push(r.chemin);
    bons.push({ ...r, cle: spec.cle, pdf });
  }
  return { ok: true, bons };
}
