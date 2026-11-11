import { ajouterJours } from './crm';

/**
 * Suggestions automatiques de l'écran « Aujourd'hui ». Ce ne sont PAS des tâches : elles sont recalculées à chaque affichage, séparées des
 * relances programmées à la main, et chacune explique pourquoi elle apparaît. Règles simples et lisibles (aucun envoi automatique) :
 *  - comptes en attente d'activation : statut « en attente » ;
 *  - clients actifs n'ayant jamais commandé : statut « actif », aucune commande non annulée ;
 *  - prospects sans suivi récent : aucun échange depuis 30 jours et aucune relance prévue ;
 *  - réassort : seulement si le rythme est FIABLE (au moins 3 commandes) ;
 *  - opportunités : « commande envisagée » ou « rendez-vous pris » sans commande depuis (jamais comptées comme des commandes).
 * Une suggestion ignorée ou reportée disparaît jusqu'à la date choisie, pour l'utilisateur seulement ; cela ne touche jamais une relance programmée.
 */
export type ClientSuggestion = {
  id: string; nom: string; societe: string | null; email: string | null; status: string; created_at: string;
  responsable_id: string | null; rattachement_groupe: 'interne' | 'externe' | null;
};
export type CommandeSuggestion = { client_id: string | null; email: string | null; created_at: string; status: string };
export type InteractionSuggestion = { client_id: string | null; occurred_at: string; resultat: string | null; annulee_le: string | null };
export type Masquage = { client_id: string; regle: string; jusqu_au: string };

export type RegleSuggestion = 'compte_en_attente' | 'actif_sans_commande' | 'prospect_sans_suivi' | 'reassort' | 'opportunite';
export type Suggestion = { regle: RegleSuggestion; clientId: string; libelle: string; groupe: 'interne' | 'externe' | null; pourquoi: string; priorite: number };
export type Sections = Record<RegleSuggestion, Suggestion[]>;

export const SEUIL_PROSPECT_JOURS = 30;
export const SEUIL_OPPORTUNITE_JOURS = 30;
export const COMMANDES_MINI_REASSORT = 3;       // en dessous, le rythme n'est pas fiable : aucune suggestion de réassort
export const COEFFICIENT_REASSORT = 1.5;        // en retard si le délai depuis la dernière commande dépasse 1,5 × le rythme habituel
export const PLANCHER_REASSORT_JOURS = 14;

/** Date de La Réunion (AAAA-MM-JJ) d'un instant UTC : pas d'heure d'été, UTC+4. */
export const dateReunion = (instant: string) => new Date(Date.parse(instant) + 4 * 3600 * 1000).toISOString().slice(0, 10);
export const joursEntre = (de: string, a: string) => Math.round((Date.parse(`${a}T00:00:00Z`) - Date.parse(`${de}T00:00:00Z`)) / 86400000);
const nomAffiche = (c: ClientSuggestion) => c.societe || c.nom;
const pl = (n: number, un: string, plusieurs: string) => `${n} ${n > 1 ? plusieurs : un}`;

export function calculerSuggestions(p: {
  clients: ClientSuggestion[]; commandes: CommandeSuggestion[]; interactions: InteractionSuggestion[]; clientsAvecRelance: Set<string>;
  masquees: Masquage[]; aujourdhui: string;
}): Sections {
  const out: Sections = { compte_en_attente: [], actif_sans_commande: [], prospect_sans_suivi: [], reassort: [], opportunite: [] };
  const masque = (id: string, regle: RegleSuggestion) => p.masquees.some(m => m.client_id === id && m.regle === regle && m.jusqu_au > p.aujourdhui);

  // commandes réelles non annulées par client (rattachement M1 par client_id, à défaut par e-mail identique)
  const parEmail = new Map<string, string>(); for (const c of p.clients) if (c.email) parEmail.set(c.email.trim().toLowerCase(), c.id);
  const commandesDe = new Map<string, string[]>();
  for (const o of p.commandes) {
    if (o.status === 'annulee') continue;
    const id = o.client_id ?? (o.email ? parEmail.get(o.email.trim().toLowerCase()) : undefined); if (!id) continue;
    (commandesDe.get(id) ?? commandesDe.set(id, []).get(id)!).push(dateReunion(o.created_at));
  }
  for (const l of commandesDe.values()) l.sort();
  const echangesDe = new Map<string, InteractionSuggestion[]>();
  for (const i of p.interactions) { if (i.annulee_le || !i.client_id) continue; (echangesDe.get(i.client_id) ?? echangesDe.set(i.client_id, []).get(i.client_id)!).push(i); }

  for (const c of p.clients) {
    const base = { clientId: c.id, libelle: nomAffiche(c), groupe: c.rattachement_groupe };
    const depuisCreation = joursEntre(dateReunion(c.created_at), p.aujourdhui);
    const cmd = commandesDe.get(c.id) ?? [];
    const dernierEchange = (echangesDe.get(c.id) ?? []).map(i => dateReunion(i.occurred_at)).sort().at(-1) ?? null;

    if (c.status === 'en_attente' && !masque(c.id, 'compte_en_attente'))
      out.compte_en_attente.push({ ...base, regle: 'compte_en_attente', priorite: depuisCreation, pourquoi: `Compte en attente d'activation depuis ${pl(depuisCreation, 'jour', 'jours')}.` });

    if (c.status === 'actif' && cmd.length === 0 && !masque(c.id, 'actif_sans_commande'))
      out.actif_sans_commande.push({ ...base, regle: 'actif_sans_commande', priorite: depuisCreation, pourquoi: `Compte actif depuis ${pl(depuisCreation, 'jour', 'jours')}, aucune commande à ce jour.` });

    if (c.status === 'prospect' && !p.clientsAvecRelance.has(c.id) && !masque(c.id, 'prospect_sans_suivi')) {
      const depuis = dernierEchange ? joursEntre(dernierEchange, p.aujourdhui) : null;
      if (depuis === null || depuis >= SEUIL_PROSPECT_JOURS)
        out.prospect_sans_suivi.push({ ...base, regle: 'prospect_sans_suivi', priorite: depuis ?? 10_000, pourquoi: depuis === null ? 'Prospect jamais contacté, aucune relance prévue.' : `Aucun échange depuis ${pl(depuis, 'jour', 'jours')}, aucune relance prévue.` });
    }

    if (c.status === 'actif' && cmd.length >= COMMANDES_MINI_REASSORT && !masque(c.id, 'reassort')) {
      const intervalles = cmd.slice(1).map((d, i) => joursEntre(cmd[i], d)).filter(n => n > 0);
      if (intervalles.length >= COMMANDES_MINI_REASSORT - 1) {
        const rythme = Math.round(intervalles.reduce((s, n) => s + n, 0) / intervalles.length);
        const depuis = joursEntre(cmd.at(-1)!, p.aujourdhui);
        if (rythme > 0 && depuis > Math.max(PLANCHER_REASSORT_JOURS, rythme * COEFFICIENT_REASSORT))
          out.reassort.push({ ...base, regle: 'reassort', priorite: depuis - rythme, pourquoi: `Commande habituelle environ tous les ${pl(rythme, 'jour', 'jours')} (sur ${cmd.length} commandes) ; la dernière date de ${pl(depuis, 'jour', 'jours')}.` });
      }
    }

    // opportunité : dernier signal d'intérêt récent, sans commande depuis (une commande envisagée n'est jamais une commande)
    const signal = (echangesDe.get(c.id) ?? []).filter(i => i.resultat === 'commande_envisagee' || i.resultat === 'rdv_pris').sort((a, b) => b.occurred_at.localeCompare(a.occurred_at))[0];
    if (signal && !masque(c.id, 'opportunite')) {
      const date = dateReunion(signal.occurred_at); const depuis = joursEntre(date, p.aujourdhui);
      if (depuis <= SEUIL_OPPORTUNITE_JOURS && !cmd.some(d => d >= date))
        out.opportunite.push({ ...base, regle: 'opportunite', priorite: -depuis, pourquoi: `${signal.resultat === 'commande_envisagee' ? 'Commande envisagée' : 'Rendez-vous pris'} il y a ${pl(depuis, 'jour', 'jours')}, aucune commande passée depuis.` });
    }
  }
  for (const l of Object.values(out)) l.sort((a, b) => b.priorite - a.priorite || a.libelle.localeCompare(b.libelle));
  return out;
}

/** Ancienneté en jours de la date d'une suggestion masquée : jusqu'à quand (AAAA-MM-JJ) pour un report de n jours. */
export const reporterJusqua = (aujourdhui: string, jours: number) => ajouterJours(aujourdhui, jours);
