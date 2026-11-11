import type { APIRoute } from 'astro';
import { portefeuille } from '../../../../lib/portefeuille';
import { traiterAction, adresseRetour } from '../../../../lib/portefeuillesActions';

/**
 * Actions de l'écran « Portefeuilles » (attribuer, transférer, prendre en charge, retirer, classer).
 * L'identité et le rôle viennent UNIQUEMENT de la session (`locals.user`, posé par le middleware à partir d'un jeton vérifié) ; le formulaire
 * ne fournit que les choix. Les règles de droits sont appliquées par la base (fonctions M1) et chaque changement est journalisé.
 */
export const POST: APIRoute = async ({ request, locals }) => {
  const user = (locals as any).user;
  if (!user) return new Response('Non autorisé', { status: 401 });
  const form = await request.formData();
  const resultat = await traiterAction(portefeuille, user, form);
  return new Response(null, { status: 303, headers: { Location: adresseRetour(form.get('retour'), resultat) } });
};
