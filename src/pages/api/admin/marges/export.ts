import type { APIRoute } from 'astro';
import { createAuthClient } from '../../../../lib/supabase';
import { isAdmin } from '../../../../lib/roles';
import { buildMargesExport, isValidDateStr } from '../../../../lib/margesExport';

// Données brutes de vente/marge/coût — hors périmètre commercial, admin
// uniquement (même règle que /admin/marges lui-même).
export const GET: APIRoute = async ({ request, cookies, url }) => {
  const supabase = createAuthClient(request, cookies);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user || !isAdmin(user)) {
    return new Response('Non autorisé', { status: 401 });
  }

  const debut = url.searchParams.get('debut');
  const fin = url.searchParams.get('fin');

  if (!isValidDateStr(debut) || !isValidDateStr(fin)) {
    return new Response('Dates invalides (attendu AAAA-MM-JJ pour debut et fin).', { status: 400 });
  }
  if (debut > fin) {
    return new Response('La date de début doit précéder la date de fin.', { status: 400 });
  }

  const { markdown } = await buildMargesExport(debut, fin);

  return new Response(markdown, {
    status: 200,
    headers: { 'Content-Type': 'text/markdown; charset=utf-8' },
  });
};
