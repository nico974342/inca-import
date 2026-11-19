import type { APIRoute } from 'astro';
import { createAuthClient, supabaseAdmin } from '../../../../lib/supabase';
import { isAdmin } from '../../../../lib/roles';
import { etatFileCump } from '../../../../lib/cump';

/** Suivi des recalculs de marge : demandes en attente, en échec, réussies sur 24 h, dernières erreurs. Lecture seule, administrateurs uniquement. */
export const GET: APIRoute = async ({ request, cookies }) => {
  const supabase = createAuthClient(request, cookies);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user || !isAdmin(user)) return new Response('Non autorisé', { status: 401 });
  const r = await etatFileCump(supabaseAdmin as any);
  return new Response(JSON.stringify(r), { status: r.ok ? 200 : 503, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
};
