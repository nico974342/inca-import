import type { APIRoute } from 'astro';
import { crm } from '../../../../lib/crm';
import { traiterActionCrm, adresseRetourCrm } from '../../../../lib/crmActions';
import { todayReunionISO } from '../../../../lib/datetime';

/**
 * Actions CRM (noter un appel, relances, interlocuteurs, délégations). L'identité et le rôle viennent UNIQUEMENT de la session
 * (`locals.user`, posé par le middleware à partir d'un jeton vérifié) ; le formulaire ne fournit que les choix. Les droits sont appliqués par
 * la base (fonctions M2) et chaque correction est journalisée.
 */
export const POST: APIRoute = async ({ request, locals }) => {
  const user = (locals as any).user;
  if (!user) return new Response('Non autorisé', { status: 401 });
  const form = await request.formData();
  const resultat = await traiterActionCrm(crm, user, form, todayReunionISO());
  return new Response(null, { status: 303, headers: { Location: adresseRetourCrm(form.get('retour'), form.get('client_id'), resultat) } });
};
