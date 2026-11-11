/** Colonnes triables de la liste des produits. */
export const CLES_TRI_PRODUITS = ['nom', 'prix', 'stock', 'marge', 'ventes_mois', 'ventes_prec'] as const;
export type CleTriProduits = (typeof CLES_TRI_PRODUITS)[number];

/**
 * Clé de tri retenue pour un paramètre ?sort= de l'adresse. Le tri par MARGE est réservé à ceux qui voient les marges :
 * pour un commercial, un classement par marge révélerait quels produits rapportent le plus, même sans afficher de chiffre.
 * Un paramètre inconnu ou interdit donne « aucun tri » (ordre par défaut).
 */
export function cleTriProduits(param: string, peutVoirMarges: boolean): CleTriProduits | '' {
  if (!(CLES_TRI_PRODUITS as readonly string[]).includes(param)) return '';
  if (param === 'marge' && !peutVoirMarges) return '';
  return param as CleTriProduits;
}
