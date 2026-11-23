/**
 * Transition sécurisée vers les réceptions partielles : les écritures qui touchent aux réceptions ou aux commandes existantes ne sont autorisées QUE dans l'état « actif ».
 * Ce contrôle est fait CÔTÉ SERVEUR, à chaque requête d'écriture (pages et routes), jamais seulement dans l'interface : un formulaire ou une page restée ouverte
 * dans un navigateur n'y change rien.
 *
 *   migration_absente : la migration SQL n'est pas encore appliquée ;
 *   inconnu           : l'état de la base n'a pas pu être vérifié (réseau, droits) → suspendu par sécurité ;
 *   gele              : migration appliquée, mais le service n'a pas encore été rouvert (drapeau ACHATS_RECEPTIONS_ACTIVES absent) ;
 *   actif             : migration appliquée ET drapeau ACHATS_RECEPTIONS_ACTIVES = 1 (réouverture explicite, après vérification du nouveau parcours).
 *
 * Pas de contournement : pas de paramètre d'URL, pas de cookie, pas de champ de formulaire qui change l'état. Seuls la base et l'environnement du serveur le décident.
 */
export type Sonde = 'oui' | 'non' | 'inconnu';
export type EtatTransition = 'migration_absente' | 'inconnu' | 'gele' | 'actif';

export const MESSAGE_TRANSITION: Record<EtatTransition, string> = {
  migration_absente: "Les réceptions par commande seront disponibles après la mise à jour de la base de données, prévue avec vous. Aucune réception ni correction de commande n'est possible pour l'instant.",
  inconnu: "Impossible de vérifier l'état de la base de données : les réceptions et les corrections de commandes sont suspendues par sécurité. Réessayez dans un instant.",
  gele: "Les réceptions par commande et les corrections de commandes sont temporairement suspendues (mise en service en cours). Elles reprendront dès que le nouveau parcours aura été vérifié.",
  actif: '',
};

/** Fonction absente de la base (migration pas encore appliquée) : code PostgreSQL 42883 ou erreur PostgREST PGRST202. */
export const estFonctionAbsente = (e: { code?: string | null; message?: string | null } | null | undefined): boolean =>
  !!e && (e.code === '42883' || e.code === 'PGRST202' || /could not find the function|function .* does not exist/i.test(String(e.message ?? '')));

export function lireEtat(sonde: Sonde, drapeau: unknown): EtatTransition {
  if (sonde === 'non') return 'migration_absente';
  if (sonde === 'inconnu') return 'inconnu';
  return String(drapeau ?? '').trim() === '1' ? 'actif' : 'gele';
}
export const ecritureAutorisee = (e: EtatTransition): boolean => e === 'actif';
/**
 * Réceptions « libres » (hors commande : création, correction, suppression) : permises avant la migration (rien n'a changé pour elles) et une fois le service rouvert ;
 * suspendues quand la migration est appliquée mais le service pas encore rouvert, ou quand l'état est invérifiable.
 */
export const receptionLibreAutorisee = (e: EtatTransition): boolean => e === 'actif' || e === 'migration_absente';

type Appel = { rpc: (nom: string, args: Record<string, unknown>) => PromiseLike<{ data: unknown; error: { code?: string | null; message?: string | null } | null }> };
const NIL = '00000000-0000-0000-0000-000000000000';

/** Sonde LECTURE SEULE : la fonction de calcul d'état existe-t-elle ? (aucune écriture, aucun effet) */
export async function sonderMigration(client: Appel): Promise<Sonde> {
  try {
    const { error } = await client.rpc('shipment_reception_etat', { p_shipment_id: NIL });
    if (!error) return 'oui';
    return estFonctionAbsente(error) ? 'non' : 'inconnu';
  } catch { return 'inconnu'; }
}

let memoire: { sonde: Sonde; a: number } | null = null;
export const oublierSonde = () => { memoire = null; };                          // pour les tests

/** État courant. Le résultat positif est gardé 30 s, tout autre résultat 3 s seulement : une réouverture ou une erreur passagère se voit presque aussitôt. */
export async function etatTransition(opts: { client?: Appel; drapeau?: unknown; maintenant?: number } = {}): Promise<EtatTransition> {
  const t = opts.maintenant ?? Date.now();
  const drapeau = 'drapeau' in opts ? opts.drapeau : ((globalThis as any).process?.env?.ACHATS_RECEPTIONS_ACTIVES ?? (import.meta as any).env?.ACHATS_RECEPTIONS_ACTIVES);
  if (!memoire || t - memoire.a > (memoire.sonde === 'oui' ? 30_000 : 3_000)) {
    const client = opts.client ?? ((await import('./supabase')).supabaseAdmin as unknown as Appel);
    memoire = { sonde: await sonderMigration(client), a: t };
  }
  return lireEtat(memoire.sonde, drapeau);
}
