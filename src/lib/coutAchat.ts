/**
 * Garde-fou sur le coût d'achat saisi dans une réception : alerte par paliers, jamais de blocage systématique (une vraie hausse de prix doit rester possible).
 * Seuils (validés) : < 20 % de variation = aucune alerte ; de 20 % à 50 % = confirmation explicite ; au-delà de 50 % ou coût supérieur au prix de vente = confirmation renforcée.
 * Un coût négatif est refusé. Un coût nul n'est accepté que pour une marchandise explicitement marquée « offerte ».
 * Fonction pure : le branchement dans les formulaires de réception viendra dans une étape séparée.
 */
export type NiveauCout = 'ok' | 'confirmer' | 'renforcee' | 'refuse';

export interface EntreeCout {
  /** Coût d'achat HT saisi, par unité de vente (carton). */
  cout: number;
  /** Coût de la dernière réception du même produit (référence habituelle), s'il existe. */
  coutReference?: number | null;
  /** Prix de vente HT du produit, s'il est connu. */
  prixVente?: number | null;
  /** Marchandise offerte / gratuite : un coût nul est alors légitime. */
  offert?: boolean;
}

export interface VerdictCout {
  niveau: NiveauCout;
  raisons: string[];
  /** Variation par rapport au coût de référence (0,25 = +25 %), null si non calculable. */
  variation: number | null;
  message: string;
}

export const SEUIL_CONFIRMER = 0.2;
export const SEUIL_RENFORCEE = 0.5;

const pct = (v: number) => `${v >= 0 ? '+' : ''}${(v * 100).toFixed(0)} %`;
const eur = (v: number) => `${v.toFixed(2).replace('.', ',')} €`;
const ordre: Record<NiveauCout, number> = { ok: 0, confirmer: 1, renforcee: 2, refuse: 3 };

export function evaluerCoutAchat(e: EntreeCout): VerdictCout {
  const raisons: string[] = [];
  let niveau: NiveauCout = 'ok';
  const monter = (n: NiveauCout) => { if (ordre[n] > ordre[niveau]) niveau = n; };

  if (!Number.isFinite(e.cout) || e.cout < 0) {
    return { niveau: 'refuse', raisons: ['cout_negatif_ou_invalide'], variation: null, message: 'Un coût d\'achat ne peut pas être négatif ni vide.' };
  }

  if (e.cout === 0) {
    if (e.offert) raisons.push('marchandise_offerte');
    else { monter('confirmer'); raisons.push('cout_nul_non_offert'); }
  } else if (e.offert) {
    monter('confirmer'); raisons.push('offert_avec_cout');
  }

  let variation: number | null = null;
  if (e.coutReference != null && e.coutReference > 0 && !(e.offert && e.cout === 0)) {
    variation = (e.cout - e.coutReference) / e.coutReference;
    const a = Math.abs(variation);
    if (a > SEUIL_RENFORCEE) { monter('renforcee'); raisons.push('variation_superieure_50'); }
    else if (a >= SEUIL_CONFIRMER) { monter('confirmer'); raisons.push('variation_20_50'); }
  }

  if (e.prixVente != null && e.prixVente > 0 && e.cout > e.prixVente) { monter('renforcee'); raisons.push('cout_superieur_prix_vente'); }

  const morceaux: string[] = [];
  if (raisons.includes('cout_nul_non_offert')) morceaux.push('Coût nul : cochez « Marchandise offerte » pour confirmer qu\'il est volontairement gratuit.');
  if (raisons.includes('offert_avec_cout')) morceaux.push('Marchandise marquée offerte mais un coût est renseigné : vérifiez.');
  if (variation != null && (raisons.includes('variation_20_50') || raisons.includes('variation_superieure_50')))
    morceaux.push(`Ce coût (${eur(e.cout)}) varie de ${pct(variation)} par rapport au coût habituel (${eur(e.coutReference as number)}).`);
  if (raisons.includes('cout_superieur_prix_vente')) morceaux.push(`Ce coût dépasse le prix de vente (${eur(e.prixVente as number)}) : la marge serait négative.`);
  if (niveau === 'renforcee') morceaux.push('Confirmation renforcée : retapez le coût pour valider.');
  else if (niveau === 'confirmer') morceaux.push('Confirmation requise.');

  return { niveau, raisons, variation, message: morceaux.join(' ') };
}
