import type { APIRoute } from 'astro';
import { supabaseAdmin } from '../../../lib/supabase';
import { balayerCump } from '../../../lib/cump';

/**
 * Balayage quotidien des recalculs de marge (filet de sécurité). Appelé par une tâche planifiée Vercel qui envoie « Authorization: Bearer <CRON_SECRET> ».
 * Sans la variable CRON_SECRET (ou avec un autre jeton), la route refuse : elle ne fait rien tant qu'elle n'est pas explicitement configurée.
 */
export const GET: APIRoute = async ({ request }) => {
  const secret = (import.meta.env.CRON_SECRET ?? process.env.CRON_SECRET ?? '') as string;
  const fourni = request.headers.get('authorization') ?? '';
  if (!secret || fourni !== `Bearer ${secret}`) return new Response('Non autorisé', { status: 401 });
  const r = await balayerCump(supabaseAdmin as any);
  return new Response(JSON.stringify(r), { status: r.ok ? 200 : 503, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
};
