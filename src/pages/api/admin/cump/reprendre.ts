import type { APIRoute } from 'astro';
import { createAuthClient, supabaseAdmin } from '../../../../lib/supabase';
import { logAdminAction } from '../../../../lib/audit';
import { isAdmin } from '../../../../lib/roles';
import { reprendreEchecsCump, balayerCump } from '../../../../lib/cump';

/** Reprise manuelle des recalculs de marge en échec (sans doublon) puis balayage de sécurité. Administrateurs uniquement. Ne modifie ni stock, ni commande, ni réception. */
export const POST: APIRoute = async ({ request, cookies }) => {
  const supabase = createAuthClient(request, cookies);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user || !isAdmin(user)) return new Response('Non autorisé', { status: 401 });
  const reprise = await reprendreEchecsCump(supabaseAdmin as any);
  const balayage = await balayerCump(supabaseAdmin as any);
  await logAdminAction({ adminEmail: user.email ?? 'inconnu', action: 'cump.reprise', targetType: 'cump', targetId: 'file', targetLabel: 'Recalculs de marge', details: { reprise: reprise.resultat ?? null, balayage: balayage.resultat ?? null } });
  const ok = reprise.ok && balayage.ok;
  return new Response(JSON.stringify({ reprise, balayage }), { status: ok ? 200 : 503, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
};
