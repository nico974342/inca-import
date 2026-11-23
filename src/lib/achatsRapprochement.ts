/**
 * Commandes fournisseurs à RAPPROCHER avant d'accepter une réception dans le nouveau parcours.
 *
 * Pourquoi : FA/1 (SDR, 590 cartons) a été en grande partie réceptionnée par l'ancien parcours (réceptions libres, stock déjà compté, cumul enregistré NULL). Dans le nouveau parcours
 * elle apparaîtrait « en attente, 0/590 » et accepterait de recevoir une seconde fois la même marchandise : double entrée en stock. Tant que son cumul n'est pas rapproché
 * (supabase/regularisation/achats_fa1_cumul.sql, après validation de l'administrateur), toute réception DE COMMANDE est refusée pour elle. Aucune donnée n'est modifiée.
 *
 * Levée AUTOMATIQUE : la protection ne s'applique que tant que la commande n'a AUCUN cumul et AUCUNE réception rattachée. Dès la régularisation, elle disparaît d'elle-même, sans nouveau
 * déploiement ; si la régularisation est annulée (retour arrière ciblé), elle se réarme. Les livraisons de FA/1 reçues d'ici là se saisissent comme avant, en réception LIBRE
 * (« Nouvelle réception » sans rattachement) : le stock est mis à jour une seule fois ; le script de régularisation refuse alors de s'exécuter tant que le rapprochement n'est pas refait.
 * Ce n'est PAS un contournement : c'est un refus supplémentaire, au niveau de l'application (même niveau que l'interrupteur ACHATS_RECEPTIONS_ACTIVES) ; les protections de la base restent entières.
 */
export const COMMANDES_A_RAPPROCHER: Readonly<Record<string, string>> = {
  '2f1712b0-dff2-416d-b2e1-8293061af20b': 'FA/1',
};

/** Propriété PROPRE seulement (jamais « constructor », « __proto__ »… hérités de l'objet). */
export const estARapprocher = (id: unknown): id is string => typeof id === 'string' && Object.prototype.hasOwnProperty.call(COMMANDES_A_RAPPROCHER, id);

export const messageRapprochement = (reference: string) =>
  `La commande ${reference} a déjà été en grande partie réceptionnée avec l'ancien parcours ; son rapprochement est en cours. Pour éviter de compter deux fois la marchandise en stock, aucune réception ne peut être enregistrée ici tant qu'il n'est pas validé. ` +
  `Une livraison reçue maintenant se saisit comme avant, par « Nouvelle réception » (sans rattachement à la commande) : le stock est mis à jour une seule fois.`;

/** true si la commande doit encore être rapprochée : listée ET sans cumul ET sans réception rattachée. Valeurs inconnues ou invalides : protégée (par prudence). */
export function rapprochementRequis(id: unknown, etat: { cumul?: unknown } | null | undefined, nbReceptions: unknown): boolean {
  if (!estARapprocher(id)) return false;
  const cumul = Number(etat?.cumul); const recs = Number(nbReceptions);
  return !(Number.isFinite(cumul) && Number.isFinite(recs) && (cumul > 0 || recs > 0));
}
