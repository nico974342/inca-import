import { acteurDepuisSession, type UtilisateurSession } from './portefeuille';
import { echeanceChoisie, estUuid, type Crm } from './crm';

/**
 * Actions CRM des formulaires (fiche client, relances, administration) : valide la demande, puis appelle les fonctions sécurisées de la
 * bibliothèque `crm`. Le formulaire n'apporte que des CHOIX ; l'identité et le rôle viennent de la session. Une relance n'est JAMAIS clôturée
 * implicitement : seule la réponse « oui » du formulaire (ou le bouton « Terminer ») la ferme.
 */
export type Formulaire = { get(nom: string): unknown; getAll(nom: string): unknown[] };
export type ResultatAction = { ok: boolean; message: string };
export type CrmActions = Pick<Crm, 'noter' | 'programmer' | 'reporter' | 'cloturer' | 'reassigner' | 'corriger' | 'annuler' | 'enregistrerContact' | 'supprimerContact' | 'accorderDelegation' | 'revoquerDelegation' | 'masquerSuggestion'>;

const refus = (message: string): ResultatAction => ({ ok: false, message });
const resume = (r: { ok: boolean; message?: string }, ok: string): ResultatAction => (r.ok ? { ok: true, message: ok } : refus((r as { message: string }).message));
const champ = (f: Formulaire, nom: string) => { const v = f.get(nom); return typeof v === 'string' ? v : ''; };

export async function traiterActionCrm(c: CrmActions, utilisateur: UtilisateurSession, f: Formulaire, aujourdhui: string): Promise<ResultatAction> {
  if (!acteurDepuisSession(utilisateur)) return refus("Vous n'avez pas le droit de faire cette action.");
  const operation = champ(f, 'operation');
  const echeance = echeanceChoisie(champ(f, 'delai'), champ(f, 'date_perso'), aujourdhui);

  if (operation === 'noter') {
    const relanceId = champ(f, 'relance_id');
    const cloture = champ(f, 'cloturer_relance');
    // Une relance nommée dans le formulaire : l'utilisateur doit dire explicitement s'il la clôture (aucune valeur par défaut).
    if (relanceId && cloture !== 'oui' && cloture !== 'non') return refus("Dites si cette relance est terminée (Oui / Non) : rien n'a été enregistré.");
    const action = champ(f, 'action');
    const avecRelance = !!action && action !== 'aucune';
    if (avecRelance && !echeance) return refus('Choisissez la date de la prochaine relance : rien n\'a été enregistré.');
    const r = await c.noter({
      utilisateur, cle: champ(f, 'cle'), clientId: champ(f, 'client_id'), type: champ(f, 'type'), resultat: champ(f, 'resultat'), commentaire: champ(f, 'commentaire'),
      action, echeance: avecRelance ? echeance : null, heure: champ(f, 'heure'), titre: champ(f, 'titre'),
      relanceACloturer: relanceId && cloture === 'oui' ? relanceId : null, assigneId: champ(f, 'assigne_id'),
    });
    if (!r.ok) return refus(r.message);
    const d = (r.data ?? {}) as { deja?: boolean; relance_id?: string | null; relance_fermee_id?: string | null };
    if (d.deja) return { ok: true, message: 'Déjà enregistré (double envoi ignoré).' };
    const parties = ['Échange enregistré', d.relance_fermee_id ? 'relance terminée' : '', d.relance_id ? 'relance programmée' : ''].filter(Boolean);
    return { ok: true, message: parties.join(' · ') + '.' };
  }

  if (operation === 'programmer') {
    if (!echeance) return refus('Choisissez la date de la relance.');
    const r = await c.programmer({ utilisateur, cle: champ(f, 'cle'), clientId: champ(f, 'client_id'), titre: champ(f, 'titre'), echeance, heure: champ(f, 'heure'), assigneId: champ(f, 'assigne_id') });
    const d = (r.ok ? r.data : {}) as { deja?: boolean };
    return r.ok ? { ok: true, message: d.deja ? 'Déjà programmée (double envoi ignoré).' : 'Relance programmée.' } : refus(r.message);
  }

  if (operation === 'reporter') {
    if (!echeance) return refus('Choisissez la nouvelle date.');
    return resume(await c.reporter({ utilisateur, relanceId: champ(f, 'relance_id'), echeance, motif: champ(f, 'motif') }), 'Relance reportée (le report est compté et journalisé).');
  }

  if (operation === 'cloturer') {
    const statut = champ(f, 'statut');
    return resume(await c.cloturer({ utilisateur, relanceId: champ(f, 'relance_id'), statut, motif: champ(f, 'motif') }), statut === 'annulee' ? 'Relance annulée.' : 'Relance terminée.');
  }

  if (operation === 'reassigner') {
    return resume(await c.reassigner({ utilisateur, relanceId: champ(f, 'relance_id'), assigneId: champ(f, 'assigne_id'), motif: champ(f, 'motif') }), 'Relance réassignée — journalisé.');
  }

  if (operation === 'corriger') {
    return resume(await c.corriger({ utilisateur, interactionId: champ(f, 'interaction_id'), resultat: champ(f, 'resultat'), commentaire: champ(f, 'commentaire'), action: champ(f, 'action'), motif: champ(f, 'motif') }), 'Activité corrigée — journalisé.');
  }

  if (operation === 'annuler') {
    return resume(await c.annuler({ utilisateur, interactionId: champ(f, 'interaction_id'), motif: champ(f, 'motif') }), 'Activité annulée (elle reste visible dans l\'historique).');
  }

  if (operation === 'contact') {
    return resume(await c.enregistrerContact({
      utilisateur, contactId: champ(f, 'contact_id'), clientId: champ(f, 'client_id'), nom: champ(f, 'nom'), fonction: champ(f, 'fonction'),
      telephone: champ(f, 'telephone'), email: champ(f, 'email'), principal: champ(f, 'principal') === '1', notes: champ(f, 'notes'),
    }), 'Interlocuteur enregistré.');
  }

  if (operation === 'contact_supprimer') {
    return resume(await c.supprimerContact({ utilisateur, contactId: champ(f, 'contact_id') }), 'Interlocuteur supprimé (journalisé).');
  }

  if (operation === 'delegation_accorder') {
    const exp = champ(f, 'expire_le');
    return resume(await c.accorderDelegation({ utilisateur, commercialId: champ(f, 'commercial_id'), proprietaireId: champ(f, 'proprietaire_id'), expireLe: exp || null, motif: champ(f, 'motif') }), 'Délégation accordée — journalisé.');
  }

  if (operation === 'delegation_revoquer') {
    return resume(await c.revoquerDelegation({ utilisateur, delegationId: champ(f, 'delegation_id'), motif: champ(f, 'motif') }), 'Délégation révoquée — journalisé.');
  }

  if (operation === 'masquer') {
    return resume(await c.masquerSuggestion({ utilisateur, clientId: champ(f, 'client_id'), regle: champ(f, 'regle'), jusquAu: echeance, motif: champ(f, 'motif') }), 'Suggestion masquée jusqu\'à la date choisie.');
  }

  return refus('Opération inconnue.');
}

/** Pages vers lesquelles on peut revenir (jamais une adresse libre) : fiche client, Aujourd'hui, Activités. */
const RETOUR = /^\/admin\/(clients\/[0-9a-f-]{36}|aujourdhui|activites)(\?[^#\s]*)?$/i;
export function adresseRetourCrm(brut: unknown, clientId: unknown, resultat: ResultatAction): string {
  const repli = estUuid(clientId) ? `/admin/clients/${clientId}` : '/admin/aujourdhui';
  const base = typeof brut === 'string' && RETOUR.test(brut) ? brut : repli;
  const u = new URL(base, 'http://local');
  u.searchParams.delete('ok'); u.searchParams.delete('err');
  u.searchParams.set(resultat.ok ? 'ok' : 'err', resultat.message);
  return `${u.pathname}${u.search}`;
}
