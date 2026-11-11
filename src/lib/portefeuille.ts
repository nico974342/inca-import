import { supabaseAdmin } from './supabase';

/**
 * Portefeuilles clients : qui est responsable de quel client, et classement Groupe Incana / externe.
 * Les RÈGLES sont appliquées par la base (fonctions client_attribuer, clients_attribuer_lot, client_classer_groupe, … : voir
 * supabase/migrations/crm_attribution.sql) ; ce module les reflète pour l'interface (quelles actions proposer) et traduit leurs erreurs.
 * Le rôle de l'acteur vient TOUJOURS de la session côté serveur (jamais d'un formulaire).
 */
export type RoleStaff = 'admin' | 'commercial';
export type ActionPortefeuille = 'attribution' | 'transfert' | 'retrait' | 'prise_en_charge';
export type AttributionCommande = 'historique' | 'portefeuille' | 'sans_responsable' | 'manuelle';
export type RattachementGroupe = 'interne' | 'externe';

export const LIBELLE_ATTRIBUTION: Record<AttributionCommande, string> = {
  historique: 'Historique non attribué',
  portefeuille: 'Portefeuille du commercial',
  sans_responsable: 'Client sans responsable',
  manuelle: 'Attribuée manuellement',
};
export const LIBELLE_RATTACHEMENT: Record<RattachementGroupe | 'a_classer', string> = {
  interne: 'Groupe Incana', externe: 'Externe', a_classer: 'À classer',
};

/** Libellé de la catégorie de chiffre d'affaires d'une commande dans les statistiques. */
export function categorieAttribution(attribution: AttributionCommande, responsableEmail: string | null): string {
  if ((attribution === 'portefeuille' || attribution === 'manuelle') && responsableEmail) return responsableEmail;
  return LIBELLE_ATTRIBUTION[attribution];
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
  ACTION_INCOHERENTE: "Cette action ne correspond pas à la situation actuelle du client (rechargez la page).",
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

export type ActeurPortefeuille = { id: string; email: string; role: RoleStaff };
export type Resultat = { ok: true; data: unknown } | { ok: false; message: string };

async function appeler(fonction: string, params: Record<string, unknown>): Promise<Resultat> {
  const { data, error } = await supabaseAdmin.rpc(fonction, params);
  if (error) return { ok: false, message: messagePortefeuille(error.message) };
  return { ok: true, data };
}

/** Attribution, transfert, retrait ou prise en charge d'UN client. Journalisé par la base. */
export function attribuerClient(p: { clientId: string; action: ActionPortefeuille; nouveau: { id: string; email: string } | null; acteur: ActeurPortefeuille; motif?: string | null }) {
  return appeler('client_attribuer', {
    p_client_id: p.clientId, p_nouveau_id: p.nouveau?.id ?? null, p_nouveau_email: p.nouveau?.email ?? null, p_action: p.action,
    p_acteur_id: p.acteur.id, p_acteur_email: p.acteur.email, p_acteur_role: p.acteur.role, p_motif: p.motif ?? null,
  });
}

/** Attribution ou transfert de plusieurs clients (administrateur) : tout ou rien. */
export function attribuerClientsEnLot(p: { clientIds: string[]; nouveau: { id: string; email: string }; acteur: ActeurPortefeuille; motif: string }) {
  return appeler('clients_attribuer_lot', {
    p_client_ids: p.clientIds, p_nouveau_id: p.nouveau.id, p_nouveau_email: p.nouveau.email,
    p_acteur_id: p.acteur.id, p_acteur_email: p.acteur.email, p_acteur_role: p.acteur.role, p_motif: p.motif,
  });
}

/** Classement manuel Groupe Incana / externe (administrateur) ; null = remettre « à classer ». */
export function classerClientGroupe(p: { clientId: string; valeur: RattachementGroupe | null; acteur: ActeurPortefeuille; motif?: string | null }) {
  return appeler('client_classer_groupe', { p_client_id: p.clientId, p_valeur: p.valeur, p_acteur_email: p.acteur.email, p_acteur_role: p.acteur.role, p_motif: p.motif ?? null });
}

export function classerClientsGroupeEnLot(p: { clientIds: string[]; valeur: RattachementGroupe | null; acteur: ActeurPortefeuille; motif?: string | null }) {
  return appeler('clients_classer_groupe_lot', { p_client_ids: p.clientIds, p_valeur: p.valeur, p_acteur_email: p.acteur.email, p_acteur_role: p.acteur.role, p_motif: p.motif ?? null });
}
