import { LIBELLE_ACTION, LIBELLE_RESULTAT, LIBELLE_TYPE, ajouterJours, type ProchaineAction, type ResultatEchange, type TypeContact } from './crm';

/** Affichage du suivi commercial : fonctions pures (testées), sans accès aux données. */
export type Interaction = {
  id: string; type: TypeContact; resultat: ResultatEchange | null; commentaire: string | null; prochaine_action: ProchaineAction | null;
  occurred_at: string; created_at: string; created_by: string; created_by_email: string; nb_modifications: number;
  annulee_le: string | null; annulation_motif: string | null;
};
export type Relance = {
  id: string; content: string; type: 'relance' | 'rendez_vous'; echeance: string; heure: string | null; assigne_a: string; assigne_email: string;
  reports: number; statut: 'a_faire' | 'faite' | 'annulee'; done_at: string | null; annulee_le: string | null; annulation_motif: string | null; created_at: string;
};
export type CommandeResume = { id: string; created_at: string; status: string; total: number | null };

export type EtatRelance = 'en_retard' | 'aujourdhui' | 'a_venir';
const JOUR = 86400000;
const ecartJours = (a: string, b: string) => Math.round((Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / JOUR);

export function etatRelance(echeance: string, aujourdhui: string): EtatRelance {
  return echeance < aujourdhui ? 'en_retard' : echeance === aujourdhui ? 'aujourdhui' : 'a_venir';
}
export function libelleEcheance(echeance: string, aujourdhui: string): string {
  const n = ecartJours(echeance, aujourdhui);
  if (n < 0) return `En retard de ${-n} jour${n < -1 ? 's' : ''}`;
  if (n === 0) return "Aujourd'hui";
  if (n === 1) return 'Demain';
  return `Dans ${n} jours`;
}
/** Date lisible AAAA-MM-JJ → « mar. 18 nov. » (calcul en UTC : la date est déjà celle de La Réunion). */
export function dateCourte(date: string): string {
  return new Date(`${date}T00:00:00Z`).toLocaleDateString('fr-FR', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
}

/** Dernier échange réel (appel, visite, message, note) : les activités annulées ne comptent pas. */
export function dernierContact(interactions: Interaction[]): Interaction | null {
  return [...interactions].filter(i => !i.annulee_le).sort((a, b) => b.occurred_at.localeCompare(a.occurred_at))[0] ?? null;
}
/** Prochaine relance à faire (la plus proche) ; les relances terminées ou annulées n'y figurent pas. */
export function prochaineRelance(relances: Relance[]): Relance | null {
  return [...relances].filter(r => r.statut === 'a_faire').sort((a, b) => a.echeance.localeCompare(b.echeance) || (a.heure ?? '').localeCompare(b.heure ?? ''))[0] ?? null;
}

export type EntreeHistorique =
  | { genre: 'interaction'; date: string; interaction: Interaction }
  | { genre: 'relance'; date: string; relance: Relance }
  | { genre: 'commande'; date: string; commande: CommandeResume };
/** Historique chronologique (le plus récent d'abord) : échanges, relances (programmées, faites, annulées) et commandes réellement passées. */
export function construireHistorique(p: { interactions: Interaction[]; relances: Relance[]; commandes: CommandeResume[] }): EntreeHistorique[] {
  const e: EntreeHistorique[] = [
    ...p.interactions.map(interaction => ({ genre: 'interaction' as const, date: interaction.occurred_at, interaction })),
    // une relance figure à sa date de création : à venir elle est affichée à part (prochaines relances), ici seulement une fois traitée
    ...p.relances.filter(r => r.statut !== 'a_faire').map(relance => ({ genre: 'relance' as const, date: relance.done_at ?? relance.annulee_le ?? relance.created_at, relance })),
    ...p.commandes.map(commande => ({ genre: 'commande' as const, date: commande.created_at, commande })),
  ];
  return e.sort((a, b) => b.date.localeCompare(a.date));
}

export function titreInteraction(i: Pick<Interaction, 'type' | 'resultat'>): string {
  return i.resultat ? `${LIBELLE_TYPE[i.type]} — ${LIBELLE_RESULTAT[i.resultat]}` : LIBELLE_TYPE[i.type];
}
export function libelleProchaineAction(a: ProchaineAction | null): string | null {
  return a && a !== 'aucune' ? LIBELLE_ACTION[a] : null;
}

/** Les boutons « Corriger / Annuler » : l'auteur sous 24 h, l'administrateur toujours. La base refuse de toute façon ce qui n'est pas permis. */
export function peutModifierInteraction(i: Pick<Interaction, 'created_by' | 'created_at' | 'annulee_le'>, viewer: { id: string; role: 'admin' | 'commercial' }, maintenant: number): boolean {
  if (i.annulee_le) return false;
  return viewer.role === 'admin' || (i.created_by === viewer.id && maintenant - Date.parse(i.created_at) <= 24 * 3600 * 1000);
}

/** Dates de report proposées (les mêmes raccourcis que pour programmer). */
export const dateApres = (aujourdhui: string, jours: number) => ajouterJours(aujourdhui, jours);
