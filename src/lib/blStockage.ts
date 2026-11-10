/**
 * Enregistrement des bons de livraison : tout ou rien, AVANT l'envoi par e-mail, jamais en silence.
 * Logique pure (le stockage est injecté) : testée avec un faux dépôt dans tests/bl-stockage.spec.ts.
 *
 *   1. verifierStockageBl()  — avant de consommer le moindre numéro de BL : le stockage est-il prêt ?
 *   2. enregistrerBons()     — envoi du PDF au stockage + ligne delivery_notes (avec le contenu figé) ;
 *                              au premier échec, tout ce qui vient d'être écrit est retiré et l'erreur est renvoyée.
 * L'appelant n'envoie l'e-mail que si l'enregistrement a réussi.
 */
import type { DeliveryPDV } from './pdf';

export const BUCKET_BL = 'delivery-notes';

/** Le BL tel qu'il a été généré : permet de reproduire le PDF (signé ou non) à l'identique, indépendamment des commandes. */
export interface ContenuBl { pdv: DeliveryPDV; date: string }

export interface LigneBl {
  delivery_id: string;
  client_id: string | null;
  pdv_key: string;
  pdv_name: string;
  storage_path: string;
  contenu: ContenuBl;
}
export interface BonAEnregistrer { ligne: LigneBl; pdf: Buffer }

/** Accès au stockage et à la table, injecté (Supabase en production, faux dépôt dans les tests). Une chaîne renvoyée = message d'erreur. */
export interface DepotBl {
  /** Stockage prêt ? (bucket présent, colonne « contenu » et table des signatures présentes). null = oui. */
  pret(): Promise<string | null>;
  televerser(chemin: string, pdf: Buffer): Promise<string | null>;
  insererNote(ligne: LigneBl): Promise<string | null>;
  retirerFichiers(chemins: string[]): Promise<void>;
  retirerNotes(numeros: string[]): Promise<void>;
}

export type ResultatBl = { ok: true } | { ok: false; message: string };

export async function verifierStockageBl(depot: DepotBl): Promise<ResultatBl> {
  let erreur: string | null;
  try { erreur = await depot.pret(); } catch (e) { erreur = e instanceof Error ? e.message : String(e); }
  if (!erreur) return { ok: true };
  return {
    ok: false,
    message: `Le stockage des bons de livraison n'est pas prêt (${erreur}). Rien n'a été généré ni envoyé, aucun numéro de BL n'a été consommé. Prévenez le support avant de réessayer.`,
  };
}

export async function enregistrerBons(depot: DepotBl, bons: BonAEnregistrer[]): Promise<ResultatBl> {
  const fichiers: string[] = [];
  const numeros: string[] = [];
  const echec = async (numero: string, quoi: string, detail: string): Promise<ResultatBl> => {
    // Retour arrière : on retire ce qui a déjà été écrit pour ce lot (fichiers déposés et lignes créées).
    try { await depot.retirerNotes(numeros); } catch (e) { console.error('[bl] retrait des lignes impossible', e); }
    try { await depot.retirerFichiers(fichiers); } catch (e) { console.error('[bl] retrait des fichiers impossible', e); }
    return {
      ok: false,
      message: `Le bon de livraison ${numero} n'a pas pu être enregistré (${quoi} : ${detail}). Aucun e-mail n'a été envoyé et aucun bon de ce lot n'est conservé. Numéros consommés : ${bons.map(b => b.ligne.delivery_id).join(', ')} (inutilisés).`,
    };
  };

  for (const { ligne, pdf } of bons) {
    let e: string | null;
    try { e = await depot.televerser(ligne.storage_path, pdf); } catch (x) { e = x instanceof Error ? x.message : String(x); }
    if (e) return echec(ligne.delivery_id, 'stockage du PDF', e);
    fichiers.push(ligne.storage_path);

    try { e = await depot.insererNote(ligne); } catch (x) { e = x instanceof Error ? x.message : String(x); }
    if (e) return echec(ligne.delivery_id, 'enregistrement', e);
    numeros.push(ligne.delivery_id);
  }
  return { ok: true };
}
