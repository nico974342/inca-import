import { supabaseAdmin } from './supabase';
import { getRole } from './roles';

/**
 * Portefeuilles clients : qui est responsable de quel client, et classement Groupe Incana / externe.
 *
 * SÉCURITÉ — l'identité de celui qui agit n'est JAMAIS un paramètre :
 *  - l'acteur (id, e-mail, rôle) est déduit de la SESSION serveur (`Astro.locals.user`, posé par le middleware à partir de
 *    `supabase.auth.getUser()`, donc d'un jeton vérifié) ; le rôle ne vient que de `app_metadata` (inscriptible seulement avec la clé
 *    service_role), jamais de `user_metadata` ni d'un formulaire ;
 *  - le NOUVEAU responsable est retrouvé dans l'annuaire des comptes et doit être du personnel (admin ou commercial) : son e-mail vient de
 *    l'annuaire, pas du navigateur ; pour une « prise en charge », le nouveau responsable est l'acteur lui-même (ce n'est pas un paramètre) ;
 *  - la base applique ensuite les règles de droits et journalise (fonctions client_attribuer, clients_attribuer_lot, … : voir
 *    supabase/migrations/crm_attribution.sql). Seul le serveur peut les appeler (droits fermés à anon et authenticated depuis la phase 0).
 */
export type RoleStaff = 'admin' | 'commercial';
export type ActionPortefeuille = 'attribution' | 'transfert' | 'retrait' | 'prise_en_charge';
export type AttributionCommande = 'historique' | 'portefeuille' | 'sans_responsable' | 'manuelle';
export type RattachementGroupe = 'interne' | 'externe';
export type RattachementCommande = RattachementGroupe | 'non_classe';

export const LIBELLE_ATTRIBUTION: Record<AttributionCommande, string> = {
  historique: 'Historique non attribué',
  portefeuille: 'Portefeuille du commercial',
  sans_responsable: 'Client sans responsable',
  manuelle: 'Attribuée manuellement',
};
export const LIBELLE_RATTACHEMENT: Record<RattachementCommande, string> = {
  interne: 'Groupe Incana', externe: 'Externe', non_classe: 'Non classé',
};

/** Libellé de la catégorie de chiffre d'affaires d'une commande dans les statistiques. */
export function categorieAttribution(attribution: AttributionCommande, responsableEmail: string | null): string {
  if ((attribution === 'portefeuille' || attribution === 'manuelle') && responsableEmail) return responsableEmail;
  return LIBELLE_ATTRIBUTION[attribution];
}

// ── Statistiques : le CA historique non attribué reste dans le GLOBAL, jamais dans les PERFORMANCES INDIVIDUELLES ─────────────────
export type LigneCA = { attribution: AttributionCommande; responsable_email: string | null; rattachement_groupe: RattachementCommande; ca_ht: number };
export type VentilationCA = {
  /** Tout le chiffre d'affaires (historique et sans responsable compris). */
  global: number;
  /** Somme des performances individuelles : uniquement les commandes attribuées (portefeuille ou manuelle). */
  performancesIndividuelles: number;
  parResponsable: Record<string, { ca: number; commandes: number }>;
  historiqueNonAttribue: { ca: number; commandes: number };
  sansResponsable: { ca: number; commandes: number };
  /** Global par classification figée à la commande (les commandes historiques sont « non classé »). */
  parGroupe: Record<RattachementCommande, number>;
};
export function ventilerCA(lignes: LigneCA[]): VentilationCA {
  const v: VentilationCA = {
    global: 0, performancesIndividuelles: 0, parResponsable: {}, historiqueNonAttribue: { ca: 0, commandes: 0 },
    sansResponsable: { ca: 0, commandes: 0 }, parGroupe: { interne: 0, externe: 0, non_classe: 0 },
  };
  for (const l of lignes) {
    v.global += l.ca_ht; v.parGroupe[l.rattachement_groupe] += l.ca_ht;
    if ((l.attribution === 'portefeuille' || l.attribution === 'manuelle') && l.responsable_email) {
      const r = (v.parResponsable[l.responsable_email] ??= { ca: 0, commandes: 0 });
      r.ca += l.ca_ht; r.commandes += 1; v.performancesIndividuelles += l.ca_ht;
    } else if (l.attribution === 'historique') { v.historiqueNonAttribue.ca += l.ca_ht; v.historiqueNonAttribue.commandes += 1; }
    else { v.sansResponsable.ca += l.ca_ht; v.sansResponsable.commandes += 1; }
  }
  return v;
}

/**
 * Actions de portefeuille PERMISES sur un client (miroir des règles de la base, vérifié par test contre la base) :
 *  - administrateur : client sans responsable → attribution ou prise en charge pour lui-même ; sinon transfert ou retrait ;
 *  - commercial : uniquement la prise en charge d'un client sans responsable.
 */
export function actionsPossibles(role: RoleStaff, responsableActuelId: string | null): ActionPortefeuille[] {
  if (responsableActuelId == null) return role === 'admin' ? ['attribution', 'prise_en_charge'] : ['prise_en_charge'];
  return role === 'admin' ? ['transfert', 'retrait'] : [];
}

const MESSAGES: Record<string, string> = {
  ACTION_INTERDITE: "Vous n'avez pas le droit de faire cette action.",
  DEJA_ATTRIBUE: 'Ce client a déjà un responsable : seul un administrateur peut le transférer.',
  MOTIF_REQUIS: 'Indiquez un motif (3 caractères minimum).',
  AUCUN_CHANGEMENT: 'Ce client est déjà confié à cette personne.',
  ACTION_INCOHERENTE: 'Cette action ne correspond pas à la situation actuelle du client (rechargez la page).',
  CLIENT_INTROUVABLE: 'Client introuvable.',
  RESPONSABLE_INVALIDE: 'Responsable invalide.',
  ACTEUR_INVALIDE: 'Compte invalide pour cette action.',
  ACTION_INCONNUE: 'Action inconnue.',
  LOT_INVALIDE: 'Sélection invalide (1 à 200 clients).',
  VALEUR_INVALIDE: 'Valeur invalide.',
};
/** Message lisible pour une erreur renvoyée par les fonctions de portefeuille. */
export function messagePortefeuille(erreur: string | null | undefined): string {
  const code = Object.keys(MESSAGES).find(c => (erreur ?? '').includes(c));
  return code ? MESSAGES[code] : "L'opération a échoué : rien n'a été modifié.";
}

// ── Identité : toujours depuis la session serveur ────────────────────────────────────────────────────────────────────────────────
export type UtilisateurSession = { id?: string | null; email?: string | null; app_metadata?: { role?: string | null; [k: string]: unknown } | null; user_metadata?: unknown } | null | undefined;
export type ActeurPortefeuille = { id: string; email: string; role: RoleStaff };

/** Acteur déduit de la session ; null si ce n'est pas un compte du personnel. `user_metadata` n'est jamais lu. */
export function acteurDepuisSession(user: UtilisateurSession): ActeurPortefeuille | null {
  if (!user?.id || !user.email) return null;
  const role = getRole({ app_metadata: user.app_metadata ?? null });
  return role === 'admin' || role === 'commercial' ? { id: user.id, email: user.email, role } : null;
}

export type Resultat = { ok: true; data: unknown } | { ok: false; message: string };
type CompteAnnuaire = { id: string; email?: string | null; app_metadata?: { role?: string | null } | null } | null;
/** Dépendances externes (injectées en test) : appel des fonctions SQL et annuaire des comptes. */
export type DepotPortefeuille = {
  rpc(nom: string, params: Record<string, unknown>): Promise<{ data: unknown; error: { message: string } | null }>;
  trouverCompte(id: string): Promise<CompteAnnuaire>;
};
export const depotSupabase: DepotPortefeuille = {
  rpc: (nom, params) => supabaseAdmin.rpc(nom, params) as any,
  async trouverCompte(id) {
    const { data, error } = await supabaseAdmin.auth.admin.getUserById(id);
    return error || !data?.user ? null : { id: data.user.id, email: data.user.email, app_metadata: data.user.app_metadata as any };
  },
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NON_AUTORISE: Resultat = { ok: false, message: "Vous n'avez pas le droit de faire cette action." };

export function creerPortefeuille(depot: DepotPortefeuille) {
  const appeler = async (nom: string, params: Record<string, unknown>): Promise<Resultat> => {
    const { data, error } = await depot.rpc(nom, params);
    return error ? { ok: false, message: messagePortefeuille(error.message) } : { ok: true, data };
  };
  /** Nouveau responsable : un compte du personnel existant, e-mail relu dans l'annuaire. */
  const responsable = async (id: unknown): Promise<{ id: string; email: string } | null> => {
    if (typeof id !== 'string' || !UUID.test(id)) return null;
    const c = await depot.trouverCompte(id);
    const role = c ? getRole({ app_metadata: c.app_metadata ?? null }) : null;
    return c?.email && (role === 'admin' || role === 'commercial') ? { id: c.id, email: c.email } : null;
  };
  const ids = (l: unknown): string[] | null => (Array.isArray(l) && l.length > 0 && l.length <= 200 && l.every(x => typeof x === 'string' && UUID.test(x)) ? (l as string[]) : null);

  return {
    /** Attribution, transfert, retrait ou prise en charge d'UN client. Pour « prise_en_charge », le responsable est l'acteur. */
    async attribuerClient(p: { utilisateur: UtilisateurSession; clientId: string; action: ActionPortefeuille; nouveauId?: string | null; motif?: string | null }): Promise<Resultat> {
      const acteur = acteurDepuisSession(p.utilisateur);
      if (!acteur || !UUID.test(p.clientId)) return NON_AUTORISE;
      let nouveau: { id: string; email: string } | null = null;
      if (p.action === 'prise_en_charge') nouveau = { id: acteur.id, email: acteur.email };
      else if (p.action === 'attribution' || p.action === 'transfert') {
        nouveau = await responsable(p.nouveauId);
        if (!nouveau) return { ok: false, message: messagePortefeuille('RESPONSABLE_INVALIDE') };
      } else if (p.action !== 'retrait') return { ok: false, message: messagePortefeuille('ACTION_INCONNUE') };
      return appeler('client_attribuer', {
        p_client_id: p.clientId, p_nouveau_id: nouveau?.id ?? null, p_nouveau_email: nouveau?.email ?? null, p_action: p.action,
        p_acteur_id: acteur.id, p_acteur_email: acteur.email, p_acteur_role: acteur.role, p_motif: p.motif ?? null,
      });
    },
    /** Attribution ou transfert de plusieurs clients (administrateur) : tout ou rien. */
    async attribuerClientsEnLot(p: { utilisateur: UtilisateurSession; clientIds: unknown; nouveauId: unknown; motif: string }): Promise<Resultat> {
      const acteur = acteurDepuisSession(p.utilisateur); const liste = ids(p.clientIds);
      if (!acteur || acteur.role !== 'admin') return NON_AUTORISE;
      const nouveau = await responsable(p.nouveauId);
      if (!liste) return { ok: false, message: messagePortefeuille('LOT_INVALIDE') };
      if (!nouveau) return { ok: false, message: messagePortefeuille('RESPONSABLE_INVALIDE') };
      return appeler('clients_attribuer_lot', {
        p_client_ids: liste, p_nouveau_id: nouveau.id, p_nouveau_email: nouveau.email,
        p_acteur_id: acteur.id, p_acteur_email: acteur.email, p_acteur_role: acteur.role, p_motif: p.motif,
      });
    },
    /** Classement manuel Groupe Incana / externe (administrateur) ; null = remettre « à classer ». */
    async classerClient(p: { utilisateur: UtilisateurSession; clientId: string; valeur: RattachementGroupe | null; motif?: string | null }): Promise<Resultat> {
      const acteur = acteurDepuisSession(p.utilisateur);
      if (!acteur || acteur.role !== 'admin' || !UUID.test(p.clientId)) return NON_AUTORISE;
      return appeler('client_classer_groupe', { p_client_id: p.clientId, p_valeur: p.valeur, p_acteur_email: acteur.email, p_acteur_role: acteur.role, p_motif: p.motif ?? null });
    },
    async classerClientsEnLot(p: { utilisateur: UtilisateurSession; clientIds: unknown; valeur: RattachementGroupe | null; motif?: string | null }): Promise<Resultat> {
      const acteur = acteurDepuisSession(p.utilisateur); const liste = ids(p.clientIds);
      if (!acteur || acteur.role !== 'admin') return NON_AUTORISE;
      if (!liste) return { ok: false, message: messagePortefeuille('LOT_INVALIDE') };
      return appeler('clients_classer_groupe_lot', { p_client_ids: liste, p_valeur: p.valeur, p_acteur_email: acteur.email, p_acteur_role: acteur.role, p_motif: p.motif ?? null });
    },
  };
}

/** Version de production (annuaire et fonctions SQL réels). */
export const portefeuille = creerPortefeuille(depotSupabase);
