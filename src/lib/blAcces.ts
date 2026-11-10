/**
 * Droits de consultation d'un BL par un CLIENT (le personnel admin / commercial voit tout). Règle pure, testée dans
 * tests/bl-commande.spec.ts.
 *
 * Un BL rattaché à des commandes : le client y accède si TOUTES ces commandes sont les siennes (identifiant du compte).
 * Dès qu'une commande appartient à un autre compte, l'accès est refusé. Quand une commande n'a pas de compte enregistré
 * (commande saisie par l'équipe), on retombe sur le rattachement historique du BL à la fiche client (client_id).
 * Un BL sans aucune commande (ancien BL, BL libre) ne dépend que de ce rattachement historique.
 */
export interface ContexteAccesBl {
  /** Identifiant du compte connecté (auth.users.id). */
  userId: string;
  /** Fiche client du compte connecté, si trouvée. */
  accountId: string | null;
  /** Fiche client rattachée au BL (delivery_notes.client_id). */
  noteClientId: string | null;
  /** Propriétaires (auth user_id) des commandes liées au BL ; null = commande sans compte. */
  liens: { user_id: string | null }[];
}

export function clientPeutConsulterBl(c: ContexteAccesBl): boolean {
  const rattache = c.accountId != null && c.noteClientId != null && c.noteClientId === c.accountId;
  if (c.liens.length === 0) return rattache;
  if (c.liens.some(l => l.user_id != null && l.user_id !== c.userId)) return false;   // une commande d'un autre compte : jamais
  if (c.liens.every(l => l.user_id === c.userId)) return true;                          // toutes les commandes sont les siennes
  return rattache;                                                                      // commandes sans compte : rattachement historique
}
