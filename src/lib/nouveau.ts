/**
 * Badge « Nouveau » : règles pures, sans accès base. Voir supabase/migrations/products_nouveau.sql.
 * L'expiration est calculée à la lecture (aucune tâche planifiée).
 */
import { NOUVEAU_DUREE_JOURS } from './constants';
export { NOUVEAU_DUREE_JOURS };
const JOUR_MS = 86_400_000;
const FUSEAU_REUNION_MS = 4 * 3_600_000;   // UTC+4, sans heure d'été

export type NouveauMode = 'auto' | 'manuel' | 'desactive';
export interface NouveauChamps {
  nouveau_mode?: string | null;
  nouveau_debut?: string | null;
  nouveau_fin?: string | null;
}

/** Vrai si le badge doit s'afficher à l'instant `now`. Une désactivation volontaire prime toujours. */
export function estNouveau(p: NouveauChamps | null | undefined, now: Date = new Date()): boolean {
  if (!p || p.nouveau_mode === 'desactive' || !p.nouveau_debut || !p.nouveau_fin) return false;
  const debut = Date.parse(p.nouveau_debut), fin = Date.parse(p.nouveau_fin), t = now.getTime();
  return Number.isFinite(debut) && Number.isFinite(fin) && debut <= t && t < fin;
}

export const finParDefaut = (debut: Date): Date => new Date(debut.getTime() + NOUVEAU_DUREE_JOURS * JOUR_MS);

/** « AAAA-MM-JJ » (calendrier de La Réunion) d'un instant : pour préremplir le champ date. */
export const dateReunion = (iso: string | null | undefined): string =>
  iso && Number.isFinite(Date.parse(iso)) ? new Date(Date.parse(iso) + FUSEAU_REUNION_MS).toISOString().slice(0, 10) : '';

/** Fin choisie à la main : le jour indiqué est inclus, jusqu'à 23 h 59 min 59 s heure de La Réunion. null si illisible. */
export function finDepuisDate(jour: string | null | undefined): Date | null {
  if (!jour || !/^\d{4}-\d{2}-\d{2}$/.test(jour)) return null;
  if (new Date(`${jour}T00:00:00Z`).toISOString().slice(0, 10) !== jour) return null;   // 30 février, etc.
  const d = new Date(`${jour}T23:59:59+04:00`);
  return Number.isFinite(d.getTime()) ? d : null;
}

export interface DecisionNouveau {
  mode: NouveauMode;
  debut: Date | null;
  fin: Date | null;
  change: boolean;
}

/** Date de fin affichée dans le formulaire : celle enregistrée, sinon maintenant + 30 jours. */
export const finAffichee = (actuel: NouveauChamps, now: Date = new Date()): string =>
  dateReunion(actuel.nouveau_fin) || dateReunion(finParDefaut(now).toISOString());

/**
 * Décision à l'enregistrement de la fiche produit (finSaisie = valeur du champ date, « AAAA-MM-JJ »).
 *  - case cochée, badge déjà affiché : on garde le début ; la fin change seulement si la date saisie a été modifiée ;
 *  - case cochée, badge non affiché (jamais activé, expiré, désactivé) : nouveau cycle, début = maintenant,
 *    fin = date saisie SI elle a été modifiée et qu'elle est dans le futur, sinon maintenant + 30 jours ;
 *  - case décochée, badge affiché : désactivation immédiate (mode « desactive », prioritaire sur l'automatisme) ;
 *  - case décochée, badge non affiché : rien ne change (enregistrer une fiche ne désactive jamais un produit par accident).
 */
export function decider(actuel: NouveauChamps, cochee: boolean, finSaisie: string | null | undefined, now: Date = new Date()): DecisionNouveau {
  const mode = (['auto', 'manuel', 'desactive'].includes(actuel.nouveau_mode ?? '') ? actuel.nouveau_mode : 'auto') as NouveauMode;
  const debutActuel = actuel.nouveau_debut ? new Date(actuel.nouveau_debut) : null;
  const finActuelle = actuel.nouveau_fin ? new Date(actuel.nouveau_fin) : null;
  const rien: DecisionNouveau = { mode, debut: debutActuel, fin: finActuelle, change: false };
  const affiche = estNouveau(actuel, now);
  const saisie = finDepuisDate(finSaisie);
  const modifiee = !!saisie && finSaisie !== finAffichee(actuel, now);

  if (!cochee) return affiche ? { mode: 'desactive', debut: debutActuel, fin: now, change: true } : rien;
  if (affiche) {
    if (!modifiee) return rien;
    if (saisie!.getTime() <= now.getTime()) return { mode: 'desactive', debut: debutActuel, fin: now, change: true };   // fin passée = désactivation
    return { mode: 'manuel', debut: debutActuel, fin: saisie!, change: true };
  }
  const fin = modifiee && saisie!.getTime() > now.getTime() ? saisie! : finParDefaut(now);
  return { mode: 'manuel', debut: now, fin, change: true };
}
