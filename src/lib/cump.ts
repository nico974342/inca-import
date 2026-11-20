import { createHash, timingSafeEqual } from 'node:crypto';
/**
 * Recalcul automatique du CUMP glissant : déclenchement du traitement de la file (cump_file) APRÈS un événement (réception, livraison, annulation…).
 * Aucune de ces fonctions ne lève d'exception et aucune ne retarde l'événement d'origine au-delà d'un délai borné : un problème de calcul ne doit JAMAIS faire échouer une réception ou
 * une livraison. Un échec est journalisé ici ET conservé côté base (cump_file : tentatives, erreur, reprise) : il n'est jamais perdu silencieusement.
 * Tant que la migration n'est pas appliquée (fonction absente) ou que l'interrupteur est sur « off », l'appel est sans effet (la file est vide).
 */
interface Appel { data: any; error: { message?: string; code?: string } | null }
export interface ClientRpc { rpc: (fn: string, args?: any) => PromiseLike<any> }

export const DELAI_MAX_MS = 8000;
const REESSAI_ABSENT_MS = 60_000;
let absentJusqua = 0;                                    // migration pas encore appliquée : on ne réessaie qu'une fois par minute, sans bruit dans les journaux

export interface ResultatCump { ok: boolean; absent?: boolean; erreur?: string; resultat?: unknown }

/** Remet à zéro la mémoire « fonction absente » (tests). */
export const oublierAbsenceCump = () => { absentJusqua = 0; };

async function appeler(admin: ClientRpc, fn: string, args: Record<string, unknown> = {}, delaiMs = DELAI_MAX_MS): Promise<ResultatCump> {
  if (Date.now() < absentJusqua) return { ok: true, absent: true };
  let minuteur: ReturnType<typeof setTimeout> | undefined;
  try {
    const delai = new Promise<never>((_, rejeter) => { minuteur = setTimeout(() => rejeter(new Error(`délai dépassé (${delaiMs} ms)`)), delaiMs); });
    const { data, error } = await Promise.race([Promise.resolve(admin.rpc(fn, args)), delai]);
    if (error) {
      if (error.code === 'PGRST202' || /could not find the function|does not exist/i.test(String(error.message ?? ''))) { absentJusqua = Date.now() + REESSAI_ABSENT_MS; return { ok: true, absent: true }; }
      console.error(`[cump] ${fn} :`, error.message);
      return { ok: false, erreur: String(error.message ?? 'erreur inconnue') };
    }
    return { ok: true, resultat: data };
  } catch (e: any) {
    console.error(`[cump] ${fn} :`, e?.message ?? e);
    return { ok: false, erreur: String(e?.message ?? e) };
  } finally { if (minuteur) clearTimeout(minuteur); }
}

/** À appeler après une réception créée / modifiée / supprimée / annulée, une livraison ou son annulation. Ne lève jamais. */
export const traiterFileCump = (admin: ClientRpc, limite = 25, delaiMs = DELAI_MAX_MS) => appeler(admin, 'cump_traiter_file', { p_limite: limite }, delaiMs);
/** Reprise des recalculs en échec (sans doublon), puis traitement. */
export async function reprendreEchecsCump(admin: ClientRpc): Promise<ResultatCump> {
  const r = await appeler(admin, 'cump_reprendre_echecs'); if (!r.ok || r.absent) return r;
  const t = await traiterFileCump(admin); return { ok: t.ok, erreur: t.erreur, resultat: { reprise: r.resultat, traitement: t.resultat } };
}
/** Filet de sécurité : redépose une demande pour tout produit dont les données ont changé sans demande, puis traite. */
export async function balayerCump(admin: ClientRpc): Promise<ResultatCump> {
  const b = await appeler(admin, 'cump_detecter_obsoletes'); if (!b.ok || b.absent) return b;
  const t = await traiterFileCump(admin, 100); return { ok: t.ok, erreur: t.erreur, resultat: { redeposees: b.resultat, traitement: t.resultat } };
}
export const etatFileCump = (admin: ClientRpc) => appeler(admin, 'cump_etat_file');

/** Jeton de la tâche planifiée : exige un secret configuré d'au moins 16 caractères et un en-tête « Bearer <secret> » identique (comparaison à temps constant). Absent, court ou différent : refus. */
export function secretCronValide(secret: unknown, enTete: unknown): boolean {
  if (typeof secret !== 'string' || secret.length < 16 || typeof enTete !== 'string') return false;
  const h = (x: string) => createHash('sha256').update(x).digest();
  return timingSafeEqual(h(enTete), h(`Bearer ${secret}`));
}

export interface RapportRattrapage { ok: boolean; absent?: boolean; erreursAvant: unknown[]; echouesAvant: number; reprise?: ResultatCump; balayage?: ResultatCump; ignore?: string; dureeMs: number }

/**
 * Rattrapage quotidien (tâche planifiée, sans utilisateur) : 1) relève les erreurs en cours AVANT de les reprendre (une reprise réussie efface le message d'erreur de la demande :
 * l'historique est donc conservé au journal d'audit), 2) reprend les demandes « echoue » (sans doublon) et traite la file, 3) balaie les produits dont les données ont changé sans demande
 * et les traite. Chaque étape est isolée (l'échec de l'une n'empêche pas l'autre), bornée dans le temps, et ne modifie jamais stock, commande, réception ni facture.
 * Sûr en cas d'appels simultanés : la base prend les demandes en SKIP LOCKED et verrouille chaque produit pendant son calcul ; rejouer ne crée ni doublon ni écart.
 */
export async function rattrapageCump(admin: ClientRpc, journaliser?: (details: Record<string, unknown>) => Promise<void>, budgetMs = 40_000): Promise<RapportRattrapage> {
  const debut = Date.now(); const duree = () => Date.now() - debut;
  const etat = await etatFileCump(admin);
  if (etat.absent) return { ok: true, absent: true, erreursAvant: [], echouesAvant: 0, dureeMs: duree() };
  const e = (etat.ok ? etat.resultat : null) as { echoue?: number; dernieres_erreurs?: unknown[] } | null;
  const erreursAvant = Array.isArray(e?.dernieres_erreurs) ? (e!.dernieres_erreurs as unknown[]) : []; const echouesAvant = Number(e?.echoue ?? 0);
  const reprise = await reprendreEchecsCump(admin);
  let balayage: ResultatCump | undefined; let ignore: string | undefined;
  if (duree() < budgetMs) balayage = await balayerCump(admin); else ignore = 'balayage reporté : budget de temps dépassé (le prochain passage le reprendra)';
  const ok = etat.ok && reprise.ok && !!balayage?.ok;
  const aTracer = erreursAvant.length > 0 || echouesAvant > 0 || !ok;
  if (journaliser && aTracer) { try { await journaliser({ erreurs_avant: erreursAvant, echoues_avant: echouesAvant, reprise: reprise.resultat ?? reprise.erreur ?? null, balayage: balayage?.resultat ?? balayage?.erreur ?? ignore ?? null, ok }); } catch (err: any) { console.error('[cump] journal du rattrapage :', err?.message ?? err); } }
  if (!ok) console.error('[cump] rattrapage incomplet :', JSON.stringify({ etat: etat.erreur, reprise: reprise.erreur, balayage: balayage?.erreur, ignore }));
  return { ok, erreursAvant, echouesAvant, reprise, balayage, ignore, dureeMs: duree() };
}
