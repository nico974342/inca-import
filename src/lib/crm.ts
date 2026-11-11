import { acteurDepuisSession, depotSupabase, type DepotPortefeuille, type RoleStaff, type UtilisateurSession, type Resultat } from './portefeuille';
import { getRole } from './roles';

/**
 * CRM commercial : appels, visites, notes, relances, interlocuteurs, délégations.
 *
 * SÉCURITÉ — comme pour les portefeuilles : l'identité de celui qui agit est TOUJOURS déduite de la session serveur (jamais d'un formulaire) ;
 * le formulaire n'apporte que des choix. Les droits réels (portefeuille du commercial, délégation, administrateur) sont appliqués PAR LA BASE
 * (fonctions de supabase/migrations/crm_activites.sql) : cette bibliothèque n'est qu'un passage obligé qui valide les saisies et traduit les
 * erreurs. « Commande envisagée » est un résultat d'échange, jamais une commande : rien ici n'écrit dans les commandes.
 */
export type TypeContact = 'appel' | 'visite' | 'message' | 'note';
export type ResultatEchange = 'pas_de_reponse' | 'message_laisse' | 'echange' | 'rdv_pris' | 'commande_envisagee' | 'refus' | 'autre';
export type ProchaineAction = 'rappeler' | 'visiter' | 'envoyer_offre' | 'preparer_commande' | 'aucune';

export const LIBELLE_TYPE: Record<TypeContact, string> = { appel: 'Appel', visite: 'Visite', message: 'Message', note: 'Note' };
export const LIBELLE_RESULTAT: Record<ResultatEchange, string> = {
  pas_de_reponse: 'Pas de réponse', message_laisse: 'Message laissé', echange: 'Échange effectué', rdv_pris: 'Rendez-vous pris',
  commande_envisagee: 'Commande envisagée', refus: 'Refus', autre: 'Autre',
};
export const LIBELLE_ACTION: Record<ProchaineAction, string> = {
  rappeler: 'Rappeler', visiter: 'Visiter', envoyer_offre: 'Envoyer une offre', preparer_commande: 'Préparer une commande', aucune: 'Aucune action',
};
export const RESULTATS = Object.keys(LIBELLE_RESULTAT) as ResultatEchange[];
export const ACTIONS = Object.keys(LIBELLE_ACTION) as ProchaineAction[];
export const TYPES: TypeContact[] = ['appel', 'visite', 'message', 'note'];

/** Raccourcis de date de la prochaine relance. */
export const RACCOURCIS = [
  { code: 'demain', jours: 1, libelle: 'Demain' }, { code: '3j', jours: 3, libelle: 'Dans 3 jours' },
  { code: '7j', jours: 7, libelle: 'Dans 7 jours' }, { code: '14j', jours: 14, libelle: 'Dans 14 jours' },
] as const;

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const HEURE = /^([01]\d|2[0-3]):[0-5]\d$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const estUuid = (v: unknown): v is string => typeof v === 'string' && UUID.test(v);

/** Ajoute des jours à une date AAAA-MM-JJ (calcul en UTC : aucune heure d'été à La Réunion, donc aucun décalage). */
export function ajouterJours(date: string, jours: number): string {
  const d = new Date(`${date}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + jours); return d.toISOString().slice(0, 10);
}
export function dateValide(v: unknown): v is string {
  if (typeof v !== 'string' || !DATE.test(v)) return false;
  const d = new Date(`${v}T00:00:00Z`); return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}
/** Échéance choisie dans le formulaire : un raccourci (demain, 3j, 7j, 14j) ou « date » + date personnalisée. null si absente ou invalide. */
export function echeanceChoisie(delai: unknown, datePerso: unknown, aujourdhui: string): string | null {
  const r = RACCOURCIS.find(x => x.code === delai);
  if (r) return ajouterJours(aujourdhui, r.jours);
  if (delai === 'date' && dateValide(datePerso)) return datePerso;
  return null;
}
/** Numéro utilisable dans un lien « tel: » (chiffres, + initial) ; null si le numéro n'est pas exploitable. */
export function lienTelephone(brut: string | null | undefined): string | null {
  const s = (brut ?? '').trim(); if (!s) return null;
  const n = (s.startsWith('+') ? '+' : '') + s.replace(/\D/g, '');
  return n.replace('+', '').length >= 6 && n.replace('+', '').length <= 15 ? `tel:${n}` : null;
}

const MESSAGES: Record<string, string> = {
  ACTION_INTERDITE: "Ce client n'est pas dans votre portefeuille : demandez une délégation à un administrateur, ou prenez-le en charge s'il n'a pas de responsable.",
  CLIENT_INTROUVABLE: 'Client introuvable.', RESULTAT_REQUIS: "Choisissez le résultat de l'échange.", RESULTAT_INVALIDE: 'Résultat invalide.',
  COMMENTAIRE_REQUIS: 'Précisez en quelques mots (3 caractères minimum) : obligatoire pour « Autre » et pour une note.',
  COMMENTAIRE_TROP_LONG: 'Commentaire trop long (2000 caractères au maximum).', TYPE_INVALIDE: 'Type invalide.', ACTION_INVALIDE: 'Action invalide.',
  ACTION_INCOHERENTE: 'La prochaine action « aucune » ne peut pas avoir de date.',
  DATE_INVALIDE: "Date de l'échange invalide.", ECHEANCE_REQUISE: 'Choisissez la date de la prochaine relance.',
  ECHEANCE_INVALIDE: 'Date invalide : elle doit être aujourd\'hui ou plus tard (un an au maximum).',
  RELANCE_INTROUVABLE: 'Relance introuvable.', RELANCE_AUTRE_CLIENT: 'Cette relance concerne un autre client.',
  RELANCE_DEJA_TRAITEE: 'Cette relance est déjà terminée ou annulée.', CLE_DEJA_UTILISEE: 'Opération déjà enregistrée par une autre personne.',
  RESPONSABLE_INVALIDE: 'Responsable invalide.', ACTEUR_INVALIDE: 'Compte invalide pour cette action.', MOTIF_REQUIS: 'Indiquez un motif (3 caractères minimum).',
  AUCUN_CHANGEMENT: 'Rien à changer.', STATUT_INVALIDE: 'Statut invalide.',
  INTERACTION_INTROUVABLE: 'Activité introuvable.', INTERACTION_ANNULEE: 'Cette activité est déjà annulée.',
  DELAI_DEPASSE: 'Plus de 24 h après la saisie : seul un administrateur peut corriger ou annuler (avec un motif).',
  NOM_INVALIDE: 'Nom invalide (2 à 120 caractères).', CONTACT_INTROUVABLE: 'Interlocuteur introuvable.',
  DELEGATION_EXISTANTE: 'Une délégation active existe déjà pour ces deux personnes.', DELEGATION_INTROUVABLE: 'Délégation introuvable.',
  DELEGATION_DEJA_REVOQUEE: 'Cette délégation est déjà révoquée.', REGLE_INVALIDE: 'Règle invalide.',
};
export function messageCrm(erreur: string | null | undefined): string {
  const code = Object.keys(MESSAGES).find(c => (erreur ?? '').includes(c));
  return code ? MESSAGES[code] : "L'opération a échoué : rien n'a été enregistré.";
}

const NON_AUTORISE: Resultat = { ok: false, message: "Vous n'avez pas le droit de faire cette action." };
const refus = (code: string): Resultat => ({ ok: false, message: messageCrm(code) });
const texte = (v: unknown, max: number) => { const s = String(v ?? '').replace(/\s+/g, ' ').trim(); return s.length > max ? s.slice(0, max) : s; };
const optionnel = (v: unknown, max: number) => texte(v, max) || null;
/** Commentaire libre : les retours à la ligne sont conservés ; ni coupé en silence ni accepté trop long (la base refuse aussi au-delà de 2000). */
const MAX_COMMENTAIRE = 2000;
const commentaireNet = (v: unknown): string | null => String(v ?? '').replace(/\r\n?/g, '\n').replace(/[ \t]+/g, ' ').trim() || null;

export type Crm = ReturnType<typeof creerCrm>;
export function creerCrm(depot: DepotPortefeuille) {
  const appeler = async (nom: string, params: Record<string, unknown>): Promise<Resultat> => {
    const { data, error } = await depot.rpc(nom, params);
    return error ? { ok: false, message: messageCrm(error.message) } : { ok: true, data };
  };
  const acteurDe = (u: UtilisateurSession) => {
    const a = acteurDepuisSession(u);
    return a ? { a, base: { p_acteur_id: a.id, p_acteur_email: a.email, p_acteur_role: a.role as RoleStaff } } : null;
  };
  /** Personne à qui confier une relance : réservé à l'administrateur ; compte du personnel relu dans l'annuaire (pas dans le navigateur). */
  const assigne = async (acteurRole: RoleStaff, id: unknown): Promise<{ id: string; email: string } | null | 'refus'> => {
    if (id == null || id === '') return null;
    if (acteurRole !== 'admin' || !estUuid(id)) return 'refus';
    const c = await depot.trouverCompte(id);
    const role = c ? getRole({ app_metadata: c.app_metadata ?? null }) : null;
    return c?.email && (role === 'admin' || role === 'commercial') ? { id: c.id, email: c.email } : 'refus';
  };

  return {
    /** Note un appel, une visite, un message ou une note ; peut clôturer UNE relance nommée et programmer la suivante, en une seule opération. */
    async noter(p: {
      utilisateur: UtilisateurSession; cle: unknown; clientId: unknown; type: unknown; resultat?: unknown; commentaire?: unknown; action?: unknown;
      echeance?: string | null; heure?: unknown; titre?: unknown; relanceACloturer?: unknown; assigneId?: unknown; occurredAt?: string | null;
    }): Promise<Resultat> {
      const x = acteurDe(p.utilisateur); if (!x) return NON_AUTORISE;
      if (!estUuid(p.cle) || !estUuid(p.clientId)) return refus('CLIENT_INTROUVABLE');
      if (!TYPES.includes(p.type as TypeContact)) return refus('TYPE_INVALIDE');
      const resultat = p.resultat === '' || p.resultat == null ? null : String(p.resultat);
      if (resultat && !RESULTATS.includes(resultat as ResultatEchange)) return refus('RESULTAT_INVALIDE');
      const commentaire = commentaireNet(p.commentaire); if (commentaire && commentaire.length > MAX_COMMENTAIRE) return refus('COMMENTAIRE_TROP_LONG');
      const action = p.action === '' || p.action == null ? null : String(p.action);
      if (action && !ACTIONS.includes(action as ProchaineAction)) return refus('ACTION_INVALIDE');
      const heure = p.heure ? String(p.heure) : null; if (heure && !HEURE.test(heure)) return refus('ECHEANCE_INVALIDE');
      if (p.relanceACloturer != null && p.relanceACloturer !== '' && !estUuid(p.relanceACloturer)) return refus('RELANCE_INTROUVABLE');
      const resp = await assigne(x.a.role, p.assigneId); if (resp === 'refus') return NON_AUTORISE;
      return appeler('interaction_noter', {
        p_cle: p.cle, p_client_id: p.clientId, p_type: p.type, p_resultat: resultat, p_commentaire: commentaire, p_prochaine_action: action,
        p_occurred_at: p.occurredAt ?? null, p_relance_id: p.relanceACloturer || null, p_relance_echeance: action && action !== 'aucune' ? (p.echeance ?? null) : null,
        p_relance_heure: heure, p_relance_titre: optionnel(p.titre, 200), p_assigne_id: resp?.id ?? null, p_assigne_email: resp?.email ?? null, ...x.base,
      });
    },
    /** Programme une relance (ou un rendez-vous si une heure est donnée). L'administrateur peut la confier à quelqu'un d'autre. */
    async programmer(p: { utilisateur: UtilisateurSession; cle: unknown; clientId: unknown; titre?: unknown; echeance: string | null; heure?: unknown; assigneId?: unknown }): Promise<Resultat> {
      const x = acteurDe(p.utilisateur); if (!x) return NON_AUTORISE;
      if (!estUuid(p.cle) || !estUuid(p.clientId)) return refus('CLIENT_INTROUVABLE');
      if (!p.echeance) return refus('ECHEANCE_REQUISE');
      const heure = p.heure ? String(p.heure) : null; if (heure && !HEURE.test(heure)) return refus('ECHEANCE_INVALIDE');
      const resp = await assigne(x.a.role, p.assigneId); if (resp === 'refus') return NON_AUTORISE;
      return appeler('relance_programmer', {
        p_cle: p.cle, p_client_id: p.clientId, p_titre: optionnel(p.titre, 200), p_echeance: p.echeance, p_heure: heure,
        p_assigne_id: resp?.id ?? null, p_assigne_email: resp?.email ?? null, ...x.base,
      });
    },
    async reporter(p: { utilisateur: UtilisateurSession; relanceId: unknown; echeance: string | null; motif?: unknown }): Promise<Resultat> {
      const x = acteurDe(p.utilisateur); if (!x) return NON_AUTORISE;
      if (!estUuid(p.relanceId)) return refus('RELANCE_INTROUVABLE'); if (!p.echeance) return refus('ECHEANCE_REQUISE');
      return appeler('relance_reporter', { p_task_id: p.relanceId, p_echeance: p.echeance, p_motif: optionnel(p.motif, 300), ...x.base });
    },
    /** Clôture VOLONTAIRE d'une relance : faite, ou annulée (motif obligatoire). */
    async cloturer(p: { utilisateur: UtilisateurSession; relanceId: unknown; statut: unknown; motif?: unknown }): Promise<Resultat> {
      const x = acteurDe(p.utilisateur); if (!x) return NON_AUTORISE;
      if (!estUuid(p.relanceId)) return refus('RELANCE_INTROUVABLE'); if (p.statut !== 'faite' && p.statut !== 'annulee') return refus('STATUT_INVALIDE');
      return appeler('relance_cloturer', { p_task_id: p.relanceId, p_statut: p.statut, p_motif: optionnel(p.motif, 300), ...x.base });
    },
    async reassigner(p: { utilisateur: UtilisateurSession; relanceId: unknown; assigneId: unknown; motif: unknown }): Promise<Resultat> {
      const x = acteurDe(p.utilisateur); if (!x || x.a.role !== 'admin') return NON_AUTORISE;
      if (!estUuid(p.relanceId)) return refus('RELANCE_INTROUVABLE');
      const resp = await assigne(x.a.role, p.assigneId); if (!resp || resp === 'refus') return refus('RESPONSABLE_INVALIDE');
      return appeler('relance_reassigner', { p_task_id: p.relanceId, p_assigne_id: resp.id, p_assigne_email: resp.email, p_motif: optionnel(p.motif, 300), ...x.base });
    },
    async corriger(p: { utilisateur: UtilisateurSession; interactionId: unknown; resultat?: unknown; commentaire?: unknown; action?: unknown; motif?: unknown }): Promise<Resultat> {
      const x = acteurDe(p.utilisateur); if (!x) return NON_AUTORISE; if (!estUuid(p.interactionId)) return refus('INTERACTION_INTROUVABLE');
      const commentaire = commentaireNet(p.commentaire); if (commentaire && commentaire.length > MAX_COMMENTAIRE) return refus('COMMENTAIRE_TROP_LONG');
      return appeler('interaction_corriger', {
        p_id: p.interactionId, p_resultat: p.resultat ? String(p.resultat) : null, p_commentaire: commentaire,
        p_prochaine_action: p.action ? String(p.action) : null, p_motif: optionnel(p.motif, 300), ...x.base,
      });
    },
    async annuler(p: { utilisateur: UtilisateurSession; interactionId: unknown; motif: unknown }): Promise<Resultat> {
      const x = acteurDe(p.utilisateur); if (!x) return NON_AUTORISE; if (!estUuid(p.interactionId)) return refus('INTERACTION_INTROUVABLE');
      return appeler('interaction_annuler', { p_id: p.interactionId, p_motif: optionnel(p.motif, 300), ...x.base });
    },
    async enregistrerContact(p: { utilisateur: UtilisateurSession; contactId?: unknown; clientId: unknown; nom: unknown; fonction?: unknown; telephone?: unknown; email?: unknown; principal?: boolean; notes?: unknown }): Promise<Resultat> {
      const x = acteurDe(p.utilisateur); if (!x) return NON_AUTORISE;
      if (!estUuid(p.clientId) || (p.contactId != null && p.contactId !== '' && !estUuid(p.contactId))) return refus('CLIENT_INTROUVABLE');
      return appeler('contact_enregistrer', {
        p_id: p.contactId || null, p_client_id: p.clientId, p_nom: texte(p.nom, 120), p_fonction: optionnel(p.fonction, 120), p_telephone: optionnel(p.telephone, 40),
        p_email: optionnel(p.email, 200), p_principal: !!p.principal, p_notes: optionnel(p.notes, 500), ...x.base,
      });
    },
    async supprimerContact(p: { utilisateur: UtilisateurSession; contactId: unknown }): Promise<Resultat> {
      const x = acteurDe(p.utilisateur); if (!x) return NON_AUTORISE; if (!estUuid(p.contactId)) return refus('CONTACT_INTROUVABLE');
      return appeler('contact_supprimer', { p_id: p.contactId, ...x.base });
    },
    /** Délégation (administrateur) : un commercial peut agir sur le portefeuille d'un autre, jusqu'à une date éventuelle. */
    async accorderDelegation(p: { utilisateur: UtilisateurSession; commercialId: unknown; proprietaireId: unknown; expireLe?: string | null; motif: unknown }): Promise<Resultat> {
      const x = acteurDe(p.utilisateur); if (!x || x.a.role !== 'admin') return NON_AUTORISE;
      const [com, prop] = await Promise.all([assigne('admin', p.commercialId), assigne('admin', p.proprietaireId)]);
      if (!com || com === 'refus' || !prop || prop === 'refus') return refus('RESPONSABLE_INVALIDE');
      return appeler('delegation_accorder', {
        p_commercial_id: com.id, p_commercial_email: com.email, p_proprietaire_id: prop.id, p_proprietaire_email: prop.email,
        p_expire_le: p.expireLe ?? null, p_motif: optionnel(p.motif, 300), ...x.base,
      });
    },
    async revoquerDelegation(p: { utilisateur: UtilisateurSession; delegationId: unknown; motif: unknown }): Promise<Resultat> {
      const x = acteurDe(p.utilisateur); if (!x || x.a.role !== 'admin') return NON_AUTORISE; if (!estUuid(p.delegationId)) return refus('DELEGATION_INTROUVABLE');
      return appeler('delegation_revoquer', { p_id: p.delegationId, p_motif: optionnel(p.motif, 300), ...x.base });
    },
    async masquerSuggestion(p: { utilisateur: UtilisateurSession; clientId: unknown; regle: unknown; jusquAu: string | null; motif?: unknown }): Promise<Resultat> {
      const x = acteurDe(p.utilisateur); if (!x) return NON_AUTORISE; if (!estUuid(p.clientId)) return refus('CLIENT_INTROUVABLE');
      if (!p.jusquAu) return refus('ECHEANCE_INVALIDE');
      return appeler('suggestion_masquer', { p_client_id: p.clientId, p_regle: String(p.regle ?? ''), p_jusqu_au: p.jusquAu, p_motif: optionnel(p.motif, 300), ...x.base });
    },
    /** Le commercial peut-il agir sur ce client ? (même fonction que la base, pour n'afficher que les boutons utiles) */
    async peutAgir(utilisateur: UtilisateurSession, clientId: string): Promise<boolean> {
      const x = acteurDe(utilisateur); if (!x || !estUuid(clientId)) return false;
      const r = await appeler('crm_peut_agir', { p_client_id: clientId, p_acteur_id: x.a.id, p_role: x.a.role });
      return r.ok && r.data === true;
    },
  };
}

/** Version de production (fonctions SQL et annuaire réels). */
export const crm = creerCrm(depotSupabase);
