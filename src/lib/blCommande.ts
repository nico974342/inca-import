/**
 * Règles pures liant les BL aux commandes (aucun accès base) : contenu figé d'un BL de commande, empreinte des lignes,
 * clés d'opération, accès d'un client. Testées dans tests/bl-commande.spec.ts.
 */
import { createHash } from 'node:crypto';
import type { DeliveryItem, DeliveryPDV } from './pdf';
import type { ContenuBl } from './blStockage';

export interface LigneCommande {
  product_name: string;
  quantity: number;
  unit?: string | null;
  price_ht_snapshot?: number | string | null;
  tva_rate_snapshot?: number | string | null;
}

/** Empreinte des lignes d'une commande : change si un produit, une quantité, une unité ou un prix change. L'ordre n'importe pas. */
export function empreinteCommande(lignes: readonly LigneCommande[]): string {
  const norm = lignes
    .map(l => [l.product_name ?? '', Number(l.quantity), l.unit ?? '', l.price_ht_snapshot == null ? '' : Number(l.price_ht_snapshot).toFixed(4),
      l.tva_rate_snapshot == null ? '' : Number(l.tva_rate_snapshot).toFixed(4)].join('|'))
    .sort();
  return createHash('sha256').update(norm.join('\n')).digest('hex').slice(0, 32);
}

/** Clé d'opération du BL « complet » d'une commande, créé depuis la fiche Commandes (action explicite). */
export const cleOperationCommande = (orderId: string) => `commande:${orderId}:initial`;
/** Clé d'opération d'un BL de Livraison : le jeton est posé à l'affichage du formulaire, donc un renvoi ne crée jamais un 2e BL. */
export const cleOperationLivraison = (jeton: string, pdvKey: string) => `livraison:${jeton}:${pdvKey}`;
export const jetonValide = (j: unknown): j is string => typeof j === 'string' && /^[0-9a-f-]{36}$/i.test(j);
export const estUuid = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);

export interface CommandePourBl { nom: string | null; societe: string | null }
export interface ClientPourBl {
  points_de_vente?: string | null;
  livraison_rue?: string | null; livraison_ville?: string | null; livraison_code_postal?: string | null; adresse_pdv?: string | null;
  facturation_same?: boolean | null; facturation_rue?: string | null; facturation_code_postal?: string | null; facturation_ville?: string | null;
}
export interface LigneBlCommande extends LigneCommande {
  sku?: string | null;
  units_per_carton?: number | null;
}

/** Contenu figé du BL d'une commande (reprend la mise en forme du BL historique : adresse de livraison, facturation, unités par carton). */
export function construireContenuCommande(commande: CommandePourBl, lignes: readonly LigneBlCommande[], client: ClientPourBl | null, dateEmission: string): ContenuBl {
  const villePostal = [client?.livraison_code_postal, client?.livraison_ville].filter(Boolean).join(' ') || null;
  const adresse = [client?.livraison_rue, villePostal, 'La Réunion'].filter(Boolean);
  const adresseLivraison = adresse.length > 1 ? adresse.join(', ') : (client?.adresse_pdv ?? null);
  let adresseFacturation: string | null = null;
  if (client) {
    if (client.facturation_same) adresseFacturation = adresseLivraison;
    else {
      const f = [client.facturation_rue, client.facturation_code_postal, client.facturation_ville].filter(Boolean);
      adresseFacturation = f.length ? f.join(', ') : null;
    }
  }
  const items: DeliveryItem[] = lignes.map(l => ({
    product_name: l.product_name,
    quantity: l.quantity,
    unit: l.unit ?? null,
    price_ht: l.price_ht_snapshot == null ? null : Number(l.price_ht_snapshot),
    sku: l.sku ?? null,
    tva_rate: l.tva_rate_snapshot == null ? 0.085 : Number(l.tva_rate_snapshot),
    units_per_carton: l.units_per_carton ?? null,
  }));
  const pdv: DeliveryPDV = {
    name: client?.points_de_vente ?? commande.nom ?? commande.societe ?? 'Client',
    items,
    client_nom: commande.nom,
    client_societe: commande.societe ?? null,
    client_address: adresseLivraison,
    client_facturation_address: adresseFacturation,
  };
  return { pdv, date: dateEmission };
}

/** Clé de point de vente d'un BL de commande (sert au nom du fichier : « BL-0091/commande_<id>.pdf »). */
export const pdvKeyCommande = (orderId: string) => `commande_${orderId}`;

/** Statuts dans lesquels une commande peut entrer dans un BL de Livraison (ni annulée, ni déjà livrée). */
export const STATUTS_LIVRABLES = ['confirmee', 'en_preparation', 'expediee'] as const;

export interface CommandeLue {
  id: string;
  status: string | null;
  /** Numéro d'un ancien BL porté par la commande (signé sur papier) : la commande ne peut plus entrer dans un nouveau BL. */
  bl_number: string | null;
  /** Point de vente (donc client) auquel la commande correspond, recalculé CÔTÉ SERVEUR au moment de l'enregistrement. */
  pdvKey: string | null;
  /** Compte (auth) propriétaire de la commande, si elle en a un. */
  user_id: string | null;
}

/**
 * Contrôle serveur d'un BL qui rattache des commandes : on ne fait JAMAIS confiance aux identifiants reçus du navigateur.
 *  - chaque commande existe et n'est listée qu'une fois ;
 *  - elle est livrable (ni annulée, ni livrée) ;
 *  - elle n'a pas d'ancien BL (signé sur papier) : impossible de le recréer ;
 *  - elle correspond bien au point de vente et au client du BL ;
 *  - les comptes propriétaires des commandes sont tous le même (aucun mélange de clients dans un BL regroupé).
 */
export function validerCommandesDuBl(pdvKey: string, ids: readonly string[], trouvees: ReadonlyMap<string, CommandeLue>): { ok: true } | { ok: false; message: string } {
  const vus = new Set<string>();
  const comptes = new Set<string>();
  for (const id of ids) {
    if (vus.has(id)) return { ok: false, message: `Commande listée deux fois (${id.slice(0, 8)}) : aucun BL généré.` };
    vus.add(id);
    const c = trouvees.get(id);
    if (!c) return { ok: false, message: `Commande introuvable (${id.slice(0, 8)}) : aucun BL généré.` };
    if (c.bl_number) return { ok: false, message: `La commande ${id.slice(0, 8)} a déjà un ancien BL (${c.bl_number}), signé sur papier : elle ne peut pas entrer dans un nouveau BL.` };
    if (!(STATUTS_LIVRABLES as readonly string[]).includes(c.status ?? '')) return { ok: false, message: `La commande ${id.slice(0, 8)} est « ${c.status ?? 'sans statut'} » : elle ne peut pas être livrée par un nouveau BL.` };
    if (c.pdvKey !== pdvKey) return { ok: false, message: `La commande ${id.slice(0, 8)} n'appartient pas à ce point de vente / ce client : aucun BL généré.` };
    if (c.user_id) comptes.add(c.user_id);
  }
  if (comptes.size > 1) return { ok: false, message: 'Les commandes d\'un BL regroupé doivent appartenir au même compte client : aucun BL généré.' };
  return { ok: true };
}
