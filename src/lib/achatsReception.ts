import { acteurDepuisSession, depotSupabase, type DepotPortefeuille, type Resultat, type UtilisateurSession } from './portefeuille';
import { estUuid } from './crm';
import { traiterFileCump } from './cump';
import { supabaseAdmin } from './supabase';

/**
 * Suivi des achats — réceptions PARTIELLES d'une commande fournisseur.
 *
 * SÉCURITÉ — comme pour les portefeuilles et le CRM : l'identité de celui qui agit est TOUJOURS déduite de la session serveur ; le formulaire n'apporte que
 * des choix (quantités, date, BL, commentaire). Tout ce qui touche au stock passe par UNE SEULE fonction SQL atomique (reception_commande_enregistrer :
 * réception + lignes + stock + PUMP + cumuls + rattachement + état, en une transaction) : rien n'est écrit ici « après coup » depuis l'application.
 * Les règles (reste à recevoir, doublons, verrous, droits, traçabilité) sont appliquées PAR LA BASE ; cette bibliothèque valide les saisies et traduit les erreurs.
 * Unité : le carton, partout (commande, réception, stock). Aucune conversion.
 */
export type StatutReception = 'attente' | 'partielle' | 'integrale';
export const LIBELLE_RECEPTION: Record<StatutReception, string> = {
  attente: 'En attente de réception', partielle: 'Partiellement réceptionnée', integrale: 'Réceptionnée intégralement',
};

export type LigneQuantites = { quantity: number; received_quantity: number | null };
export type EtatReception = {
  lignes: number; commande: number; recu: number; reste: number; cumul: number; solde: boolean;
  statut: StatutReception;
  /** Commande clôturée « Réceptionné » avant le suivi par quantités : son stock a déjà été compté, elle n'est plus réceptionnable. */
  historique: boolean;
  /** Progression en % du commandé (100 pour une commande intégrale, même historique). */
  pourcentage: number;
};

/**
 * Quantités et état de réception d'une commande. MIROIR de shipment_reception_quantites / shipment_reception_etat (SQL) : les tests comparent les deux
 * sur de nombreux cas. Le statut de réception est CALCULÉ à partir des quantités ; il est indépendant du statut logistique (en transit, au port…), sauf pour
 * les commandes déjà clôturées « Réceptionné » avant le suivi par quantités.
 */
export function etatReception(lignes: LigneQuantites[], statutLogistique: string | null | undefined): EtatReception {
  const recu = (l: LigneQuantites) => l.received_quantity ?? 0;
  const n = lignes.length;
  const commande = lignes.reduce((s, l) => s + l.quantity, 0);
  const recuPlafonne = lignes.reduce((s, l) => s + Math.min(recu(l), l.quantity), 0);
  const reste = lignes.reduce((s, l) => s + Math.max(l.quantity - recu(l), 0), 0);
  const cumul = lignes.reduce((s, l) => s + recu(l), 0);
  const solde = n > 0 && lignes.every(l => recu(l) >= l.quantity);
  const cloturee = statutLogistique === 'receptionne' && n > 0;
  const statut: StatutReception = solde || cloturee ? 'integrale' : cumul === 0 ? 'attente' : 'partielle';
  const historique = cloturee && !solde;
  const pourcentage = statut === 'integrale' ? 100 : commande > 0 ? Math.min(99, Math.floor((recuPlafonne / commande) * 100)) : 0;
  return { lignes: n, commande, recu: recuPlafonne, reste, cumul, solde, statut, historique, pourcentage };
}

/** Filtres de la liste : commandes qui ont encore du reste à recevoir (jamais les annulées ni les clôturées avant le suivi). */
export const FILTRES_ACHATS = ['en_cours', 'reste', 'partielles', 'toutes'] as const;
export type FiltreAchats = (typeof FILTRES_ACHATS)[number];
export const LIBELLE_FILTRE_ACHATS: Record<FiltreAchats, string> = { en_cours: 'En cours', reste: 'Reste à recevoir', partielles: 'Partiellement réceptionnées', toutes: 'Toutes (historique)' };
export const parseFiltreAchats = (v: string | null | undefined): FiltreAchats => (FILTRES_ACHATS as readonly string[]).includes(v ?? '') ? (v as FiltreAchats) : 'en_cours';
export function correspondFiltre(f: FiltreAchats, e: EtatReception, statutLogistique: string): boolean {
  if (f === 'toutes') return true;
  if (statutLogistique === 'annule' || statutLogistique === 'receptionne') return false;
  if (f === 'en_cours') return true;
  if (f === 'reste') return e.reste > 0 && e.statut !== 'integrale';
  return e.statut === 'partielle';
}

// ── Messages : un code de la base → une phrase claire (jamais un simple avertissement après une mise à jour partielle) ──
const MESSAGES: Record<string, string> = {
  ACTION_INTERDITE: "Seul un administrateur peut enregistrer ou corriger une réception.",
  CLE_REQUISE: 'Envoi invalide : rechargez la page.',
  CLE_DEJA_UTILISEE: 'Cet envoi a déjà été utilisé pour une autre réception : rechargez la page.',
  CLE_REUTILISEE_AUTRES_DONNEES: 'Cette réception a déjà été enregistrée avec d\'autres quantités : rechargez la page pour voir son contenu avant de recommencer.',
  LIGNES_REQUISES: 'Aucune ligne à enregistrer.', LIGNE_INCONNUE: 'Une ligne ne fait pas partie de cette commande : rechargez la page.', LIGNE_EN_DOUBLE: 'Une ligne est présente deux fois.',
  QUANTITE_INVALIDE: 'Quantité invalide : un nombre entier de cartons, 0 si rien n\'a été livré.', COUT_INVALIDE: 'Coût unitaire invalide (nombre positif ou nul) sur une ligne reçue.',
  DLC_INVALIDE: 'DLC invalide (AAAA-MM-JJ).', DATE_INVALIDE: 'Date de réception invalide : elle ne peut pas être dans le futur.',
  TEXTE_TROP_LONG: 'Référence de BL (120 caractères) ou commentaire (500) trop long.', AUCUNE_QUANTITE: 'Saisissez au moins une quantité reçue (les lignes non livrées restent à 0).',
  COMMANDE_INTROUVABLE: 'Commande introuvable.', COMMANDE_ANNULEE: 'Cette commande est annulée : aucune réception possible.',
  COMMANDE_DEJA_SOLDEE: 'Cette commande est déjà entièrement réceptionnée : il n\'y a plus rien à recevoir.',
  PRODUIT_INTROUVABLE: 'Un produit de la commande n\'existe plus.', CUMUL_INCOHERENT: 'Le cumul de cette commande est incohérent : rien n\'a été enregistré, contactez le support.',
  DEPASSEMENT_COMMANDE: 'Quantité supérieure au reste à recevoir : refusé par défaut. Pour accepter le surplus, un administrateur doit d\'abord modifier la quantité commandée (avec une justification) ; la commande n\'est jamais augmentée automatiquement.',
  MOTIF_REQUIS: 'Indiquez un motif (3 caractères minimum).', RECEPTION_INTROUVABLE: 'Réception introuvable.', RECEPTION_NON_LIEE: 'Cette réception n\'est pas rattachée à une commande : utilisez la correction des réceptions.',
  RECEPTION_DEJA_ANNULEE: 'Cette réception est déjà annulée.', RECEPTION_VIDE: 'Cette réception n\'a aucune ligne.',
  STOCK_DEJA_ENGAGE: 'Annulation impossible : une partie du stock de cette réception a déjà été vendue, réservée ou déplacée. Rien n\'a été modifié ; régularisez le stock à la main avant d\'annuler.',
  QUANTITE_INFERIEURE_AU_RECU: 'La quantité commandée ne peut pas être inférieure à ce qui est déjà reçu.', AUCUN_CHANGEMENT: 'Rien à changer.',
  COMMANDE_CLOTUREE_HISTORIQUE: 'Cette commande a été clôturée avant le suivi par quantités : sa quantité ne se modifie pas.',
  RECEPTION_LIEE_COMMANDE: 'Une réception rattachée à une commande ne se modifie ni ne se supprime : utilisez l\'annulation motivée.',
  LIGNE_RECUE_NON_SUPPRIMABLE: 'Cette ligne a déjà reçu de la marchandise : elle ne se supprime pas.', QUANTITE_PROTEGEE: 'La quantité commandée d\'une ligne déjà reçue ne se modifie que par la modification justifiée.',
  COMMANDE_RECUE_NON_SUPPRIMABLE: 'Cette commande a des réceptions : elle ne se supprime pas (passez-la au statut annulé).',
};
const DETAILS = ['DEPASSEMENT_COMMANDE', 'STOCK_DEJA_ENGAGE', 'QUANTITE_INFERIEURE_AU_RECU'];
/** Message lisible pour une erreur de la base ; pour quelques codes, le détail chiffré de la base est conservé (reste à recevoir, stock disponible…). */
export function messageAchats(erreur: string | null | undefined): string {
  const e = erreur ?? '';
  const code = Object.keys(MESSAGES).find(c => e.includes(c));
  if (!code) return "L'opération a échoué : rien n'a été enregistré (ni stock, ni réception).";
  if (DETAILS.includes(code)) { const detail = e.split(`${code} : `)[1]?.split('\n')[0]; if (detail) return `${MESSAGES[code]} (${detail})`; }
  return MESSAGES[code];
}

// ── Saisies ──
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const NON_AUTORISE: Resultat = { ok: false, message: "Seul un administrateur peut enregistrer ou corriger une réception." };
const refus = (code: string): Resultat => ({ ok: false, message: messageAchats(code) });
/** Quantité saisie : vide = 0 ; sinon entier strict de cartons (jamais de décimale, de signe ni de texte). null si invalide. */
export function parseQuantite(v: unknown): number | null {
  const s = String(v ?? '').trim(); if (s === '') return 0;
  return /^\d{1,7}$/.test(s) ? Number(s) : null;
}
/** Coût unitaire saisi (virgule ou point) ; null si invalide. */
export function parseCout(v: unknown): number | null {
  const s = String(v ?? '').trim().replace(',', '.'); if (s === '') return null;
  return /^\d{1,9}(\.\d{1,6})?$/.test(s) ? Number(s) : null;
}
const texteCourt = (v: unknown, max: number) => { const s = String(v ?? '').replace(/\s+/g, ' ').trim(); return { valeur: s || null, trop: s.length > max }; };

export type LigneSaisie = { id: unknown; quantite: unknown; cout: unknown; dlc?: unknown };
export type Achats = ReturnType<typeof creerAchats>;
/**
 * `apresEcriture` : traitement IMMÉDIAT de la file de recalcul des marges (CUMP) une fois l'écriture validée par la base. Les demandes sont déposées par la base elle-même,
 * dans la transaction de la réception ou de l'annulation ; ici on ne fait que les traiter sans attendre le passage de nuit. Ne change jamais le résultat de l'opération
 * (une erreur est journalisée et ignorée : la demande reste en file, reprise par la tâche quotidienne).
 */
export function creerAchats(depot: DepotPortefeuille, apresEcriture: () => Promise<unknown> = async () => {}) {
  const apres = async () => { try { await apresEcriture(); } catch (e: any) { console.error('[cump] traitement après écriture :', e?.message ?? e); } };
  const appeler = async (nom: string, params: Record<string, unknown>): Promise<Resultat> => {
    const { data, error } = await depot.rpc(nom, params);
    return error ? { ok: false, message: messageAchats(error.message) } : { ok: true, data };
  };
  const admin = (u: UtilisateurSession) => {
    const a = acteurDepuisSession(u);
    return a && a.role === 'admin' ? { p_acteur_id: a.id, p_acteur_email: a.email, p_acteur_role: a.role } : null;
  };
  return {
    /** Enregistre UNE livraison : une seule opération atomique côté base. Les lignes à 0 sont ignorées ; au moins une quantité > 0. */
    async enregistrer(p: { utilisateur: UtilisateurSession; cle: unknown; shipmentId: unknown; receivedAt: unknown; bl?: unknown; notes?: unknown; lignes: LigneSaisie[] }): Promise<Resultat> {
      const acteur = admin(p.utilisateur); if (!acteur) return NON_AUTORISE;
      if (!estUuid(p.cle)) return refus('CLE_REQUISE'); if (!estUuid(p.shipmentId)) return refus('COMMANDE_INTROUVABLE');
      const date = String(p.receivedAt ?? ''); if (!DATE.test(date)) return refus('DATE_INVALIDE');
      const bl = texteCourt(p.bl, 120); const notes = texteCourt(p.notes, 500); if (bl.trop || notes.trop) return refus('TEXTE_TROP_LONG');
      if (!Array.isArray(p.lignes) || p.lignes.length === 0 || p.lignes.length > 500) return refus('LIGNES_REQUISES');
      const items: { shipment_item_id: string; quantity: number; unit_cost_ht: number; dlc: string | null }[] = [];
      for (const l of p.lignes) {
        if (!estUuid(l.id)) return refus('LIGNE_INCONNUE');
        const q = parseQuantite(l.quantite); if (q === null) return refus('QUANTITE_INVALIDE');
        if (q === 0) continue;                                                                           // ligne non livrée : rien à enregistrer
        const cout = parseCout(l.cout); if (cout === null) return refus('COUT_INVALIDE');
        const dlc = String(l.dlc ?? '').trim(); if (dlc && !DATE.test(dlc)) return refus('DLC_INVALIDE');
        items.push({ shipment_item_id: l.id, quantity: q, unit_cost_ht: cout, dlc: dlc || null });
      }
      if (items.length === 0) return refus('AUCUNE_QUANTITE');
      const r = await appeler('reception_commande_enregistrer', {
        p_cle: p.cle, p_shipment_id: p.shipmentId, p_received_at: date, p_bl: bl.valeur, p_notes: notes.valeur, p_items: items, ...acteur,
      });
      if (r.ok) await apres();                                                                           // recalcul des marges (CUMP) : après la réussite seulement
      return r;
    },
    /** Annulation (correction) d'une réception de commande : administrateur, motif obligatoire, journalisée, archivée. */
    async annuler(p: { utilisateur: UtilisateurSession; receptionId: unknown; motif: unknown }): Promise<Resultat> {
      const acteur = admin(p.utilisateur); if (!acteur) return NON_AUTORISE; if (!estUuid(p.receptionId)) return refus('RECEPTION_INTROUVABLE');
      const motif = texteCourt(p.motif, 300); if (!motif.valeur || motif.valeur.length < 3) return refus('MOTIF_REQUIS');
      const r = await appeler('reception_commande_annuler', { p_reception_id: p.receptionId, p_motif: motif.valeur, ...acteur });
      if (r.ok) await apres();                                                                           // recalcul des marges (CUMP) : après la réussite seulement
      return r;
    },
    /** Modification JUSTIFIÉE de la quantité commandée d'une ligne (jamais automatique) : administrateur, motif, historique. */
    async modifierQuantite(p: { utilisateur: UtilisateurSession; ligneId: unknown; quantite: unknown; motif: unknown }): Promise<Resultat> {
      const acteur = admin(p.utilisateur); if (!acteur) return NON_AUTORISE; if (!estUuid(p.ligneId)) return refus('LIGNE_INCONNUE');
      const q = parseQuantite(p.quantite); if (q === null || q < 1) return refus('QUANTITE_INVALIDE');
      const motif = texteCourt(p.motif, 300); if (!motif.valeur || motif.valeur.length < 3) return refus('MOTIF_REQUIS');
      return appeler('shipment_item_quantite_modifier', { p_item_id: p.ligneId, p_nouvelle: q, p_motif: motif.valeur, ...acteur });
    },
  };
}

/** Version de production (fonctions SQL réelles). */
export const achats = creerAchats(depotSupabase, () => traiterFileCump(supabaseAdmin as any));
