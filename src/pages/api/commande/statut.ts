import type { APIRoute } from 'astro';
import { createAuthClient, supabaseAdmin } from '../../../lib/supabase';
import { isClientRole } from '../../../lib/roles';

/**
 * Une commande vient-elle d'être enregistrée pour CE client ? Lecture seule. Sert après une coupure réseau pendant l'envoi : on vérifie AVANT de laisser
 * recommencer, pour ne jamais créer une commande en double. Ne renvoie que les commandes du client connecté.
 *   - par la clé d'envoi (exact) quand la base la connaît (migration orders_idempotence_cle.sql) ;
 *   - sinon, par la date : la commande la plus récente créée depuis l'affichage de la page.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const GET: APIRoute = async ({ request, cookies, url }) => {
  const json = (status: number, body: object) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
  const supabase = createAuthClient(request, cookies);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user || !isClientRole(user)) return json(401, { error: 'Unauthorized' });

  const cle = url.searchParams.get('cle') ?? '';
  const depuis = new Date(url.searchParams.get('depuis') ?? '');
  if (!UUID.test(cle) || Number.isNaN(depuis.getTime())) return json(400, { error: 'Invalid input' });

  const parCle = await supabaseAdmin.from('orders').select('id').eq('user_id', user.id).eq('cle_commande', cle).maybeSingle();
  if (!parCle.error) return json(200, parCle.data ? { enregistree: true, orderId: parCle.data.id } : { enregistree: false });   // clé connue de la base : réponse exacte

  // Colonne absente (migration pas encore appliquée) : repli sur la date.
  const { data, error } = await supabaseAdmin.from('orders').select('id').eq('user_id', user.id).gte('created_at', depuis.toISOString()).order('created_at', { ascending: false }).limit(1).maybeSingle();
  if (error) return json(500, { error: 'Erreur serveur' });
  return json(200, data ? { enregistree: true, orderId: data.id } : { enregistree: false });
};
