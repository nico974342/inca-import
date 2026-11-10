import type { APIRoute } from 'astro';
import { supabaseAdmin } from '../../../../../lib/supabase';
import { isAdmin } from '../../../../../lib/roles';
import { estUuid } from '../../../../../lib/blCommande';
import { LIBELLE_ROLE, estRoleSignature } from '../../../../../lib/signatureBl';

/**
 * Annulation EXPLICITE d'une signature, depuis la fiche d'une commande (bloc Bon de livraison).
 *  - administrateur uniquement (un commercial est refusé, même par requête directe) ;
 *  - motif obligatoire (3 caractères minimum) ET confirmation explicite (case cochée) exigés côté serveur ;
 *  - ne supprime JAMAIS : la signature d'origine, son auteur, sa date et l'image restent en base ; seuls annulee_le, annulee_par
 *    (l'administrateur) et annulation_motif sont renseignés. La base refuse toute autre modification et toute suppression ;
 *  - n'agit que sur LA signature désignée, donc sur le seul BL concerné (une commande peut avoir plusieurs BL) ;
 *  - ne touche ni au contenu figé du BL, ni à son numéro, ni au statut, aux stocks ou à la facturation de la commande ;
 *  - n'envoie aucun e-mail. La trace dans admin_audit_logs est écrite par la base (trigger bl_signatures_journal), dans la même transaction.
 * Après l'annulation, le BL repasse à « Signé partiellement » ou « Non signé » selon les signatures encore actives, et une nouvelle
 * signature peut être recueillie (« Faire signer » / « Terminer la signature »).
 * Reçoit un formulaire (POST) et renvoie vers la fiche de la commande (champ « retour » = identifiant de la commande).
 */
const retour = (message: string, ok: boolean, orderId: string | null) =>
  new Response(null, {
    status: 303,
    headers: { Location: `/admin/commandes?${ok ? 'bl_ok' : 'bl_err'}=${encodeURIComponent(message)}${orderId ? `&ouvrir=${orderId}#cmd-${orderId}` : ''}` },
  });

export const POST: APIRoute = async ({ params, request, locals }) => {
  const user = (locals as any).user;
  if (!user?.email) return new Response('Non autorisé', { status: 401 });

  const form = await request.formData();
  const brut = String(form.get('retour') ?? '');
  const orderId = estUuid(brut) ? brut : null;

  if (!isAdmin(user)) return retour('Seul un administrateur peut annuler une signature.', false, orderId);

  const id = params.id ?? '';
  if (!estUuid(id)) return retour('Signature introuvable.', false, orderId);
  const motif = String(form.get('motif') ?? '').replace(/\s+/g, ' ').trim().slice(0, 300);
  if (motif.length < 3) return retour("Indiquez le motif de l'annulation (3 caractères minimum).", false, orderId);
  if (form.get('confirme') !== 'oui') return retour("Confirmez explicitement l'annulation (case à cocher) : rien n'a été annulé.", false, orderId);

  const { data: sig } = await supabaseAdmin
    .from('bl_signatures').select('id, role, signataire_nom, delivery_note_id, annulee_le, delivery_notes(delivery_id)').eq('id', id).maybeSingle();
  if (!sig) return retour('Signature introuvable.', false, orderId);
  if ((sig as any).annulee_le) return retour('Cette signature est déjà annulée.', false, orderId);

  const { data: modifiees, error } = await supabaseAdmin
    .from('bl_signatures')
    .update({ annulee_le: new Date().toISOString(), annulee_par: user.email, annulation_motif: motif })
    .eq('id', id)
    .is('annulee_le', null)
    .select('id');
  if (error) {
    console.error('[bl_signatures] annulation:', error.message);
    return retour("L'annulation a échoué : rien n'a été annulé.", false, orderId);
  }
  // Deux annulations simultanées : une seule a lieu, l'autre l'apprend (jamais de faux succès).
  if (!modifiees || modifiees.length === 0) return retour('Cette signature est déjà annulée.', false, orderId);

  const role = estRoleSignature((sig as any).role) ? LIBELLE_ROLE[(sig as any).role].toLowerCase() : 'signature';
  const numero = (sig as any).delivery_notes?.delivery_id ?? 'du BL';
  // Journal : écrit par la base (trigger bl_signatures_journal) dans la même transaction que l'annulation.
  return retour(`Signature du ${role} annulée sur ${numero} : elle est conservée dans l'historique avec le motif. Le BL peut être signé à nouveau.`, true, orderId);
};
