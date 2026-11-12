/**
 * Panier client : évaluation de chaque ligne contre la disponibilité RÉELLE (physique − réservé), et plan d'ajustement.
 *
 * Principes :
 *  - le panier n'est JAMAIS modifié sans que le client l'ait vu et demandé (aperçu, puis confirmation) ;
 *  - la disponibilité utilisée ici est la même que celle de la fonction SQL de création de commande (vue product_availability) ;
 *    le contrôle final reste fait par la base, dans la transaction de création : ceci ne sert qu'à informer et à ajuster.
 *  - fonctions pures : aucune lecture ni écriture ici.
 */

export type LignePanier = { product_id: string; nom: string; quantity: number; unit: string | null };

/** Ce que l'on sait d'un produit du panier. `undefined` (absent de la carte) = produit disparu. */
export type Disponibilite = { available: number; commandable: boolean };

export type StatutLigne = 'ok' | 'reduire' | 'epuise' | 'retire_catalogue';

export type EvaluationLigne = {
  product_id: string; nom: string; unit: string | null;
  demande: number; disponible: number;
  statut: StatutLigne;
  /** Quantité à laquelle la ligne peut être ramenée (0 = à retirer). */
  cible: number;
};

export type Ajustement = {
  product_id: string; nom: string; unit: string | null;
  action: 'retirer' | 'reduire';
  de: number; vers: number;
  raison: 'epuise' | 'insuffisant' | 'retire_catalogue';
};

/** Évalue une ligne. `dispo` absent = produit disparu ; `commandable` faux = masqué du catalogue pour ce client. */
export function evaluerLigne(l: LignePanier, dispo: Disponibilite | undefined): EvaluationLigne {
  const base = { product_id: l.product_id, nom: l.nom, unit: l.unit, demande: l.quantity };
  if (!dispo || !dispo.commandable) return { ...base, disponible: 0, statut: 'retire_catalogue', cible: 0 };
  const disponible = Math.max(0, Math.trunc(dispo.available));
  if (disponible === 0) return { ...base, disponible: 0, statut: 'epuise', cible: 0 };
  if (l.quantity > disponible) return { ...base, disponible, statut: 'reduire', cible: disponible };
  return { ...base, disponible, statut: 'ok', cible: l.quantity };
}

export function evaluerPanier(lignes: LignePanier[], dispos: Map<string, Disponibilite>): EvaluationLigne[] {
  return lignes.map(l => evaluerLigne(l, dispos.get(l.product_id)));
}

export const lignesEnProbleme = (ev: EvaluationLigne[]): EvaluationLigne[] => ev.filter(e => e.statut !== 'ok');

/** Plan d'ajustement : retirer ce qui n'est plus commandable, ramener au disponible ce qui est insuffisant. Rien d'autre n'est touché. */
export function planAjustement(ev: EvaluationLigne[]): Ajustement[] {
  return lignesEnProbleme(ev).map(e => e.statut === 'reduire'
    ? { product_id: e.product_id, nom: e.nom, unit: e.unit, action: 'reduire' as const, de: e.demande, vers: e.cible, raison: 'insuffisant' as const }
    : { product_id: e.product_id, nom: e.nom, unit: e.unit, action: 'retirer' as const, de: e.demande, vers: 0, raison: e.statut === 'epuise' ? 'epuise' as const : 'retire_catalogue' as const });
}

/** Signature du plan : l'envoi de confirmation ne vaut que pour CE plan. Si la disponibilité a encore changé, la signature diffère et on remontre l'aperçu. */
export const signaturePlan = (plan: Ajustement[]): string =>
  plan.map(a => `${a.product_id}:${a.action}:${a.vers}`).sort().join('|');

export const signaturePanier = (lignes: { product_id: string; quantity: number }[]): string =>
  lignes.map(l => `${l.product_id}:${l.quantity}`).sort().join('|');

const pluriel = (n: number, unit: string | null) => { const u = unit || 'carton'; return `${n} ${u}${n > 1 ? 's' : ''}`; };

/** Phrase claire pour une ligne : quantités demandée et disponible. */
export function messageLigne(e: EvaluationLigne): string {
  if (e.statut === 'ok') return '';
  if (e.statut === 'retire_catalogue') return `Ce produit n'est plus proposé à la commande (${pluriel(e.demande, e.unit)} dans votre panier).`;
  if (e.statut === 'epuise') return `Épuisé : ${pluriel(e.demande, e.unit)} demandé${e.demande > 1 ? 's' : ''}, aucun disponible.`;
  return `Stock insuffisant : ${pluriel(e.demande, e.unit)} demandé${e.demande > 1 ? 's' : ''}, ${pluriel(e.disponible, e.unit)} disponible${e.disponible > 1 ? 's' : ''}.`;
}

export function messageAjustement(a: Ajustement): string {
  return a.action === 'reduire'
    ? `${a.nom} : ${a.de} → ${a.vers} (stock disponible)`
    : `${a.nom} : retiré (${a.raison === 'epuise' ? 'épuisé' : 'plus proposé'}, ${a.de} demandé${a.de > 1 ? 's' : ''})`;
}

/** Résumé en une phrase, pour un message de confirmation. */
export function resumeAjustements(plan: Ajustement[]): string {
  const r = plan.filter(a => a.action === 'retirer').length, d = plan.filter(a => a.action === 'reduire').length;
  const morceaux = [r ? `${r} produit${r > 1 ? 's' : ''} retiré${r > 1 ? 's' : ''}` : '', d ? `${d} quantité${d > 1 ? 's' : ''} réduite${d > 1 ? 's' : ''}` : ''].filter(Boolean);
  return morceaux.join(' · ') || 'Aucun ajustement';
}

export type ResultatConflit = { product_id: string; product_name: string; requested: number; available: number };
/** Conflits renvoyés par la base → même vocabulaire que l'évaluation (pour les afficher avec exactement les mêmes mots). */
export const conflitVersEvaluation = (c: ResultatConflit, unit: string | null = null): EvaluationLigne =>
  evaluerLigne({ product_id: c.product_id, nom: c.product_name, quantity: c.requested, unit }, { available: c.available, commandable: true });
