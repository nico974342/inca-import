import type { APIRoute } from 'astro';
import { supabaseAdmin } from '../../../lib/supabase';
import { logAdminAction } from '../../../lib/audit';
import { rattrapageCump, secretCronValide } from '../../../lib/cump';

/**
 * Rattrapage quotidien des recalculs de marge (tâche planifiée Vercel, « Authorization: Bearer <CRON_SECRET> » envoyé par Vercel).
 * Refuse tout appel si CRON_SECRET est absent, trop court (< 16 caractères) ou différent du jeton fourni : aucune lecture ni écriture avant cette vérification.
 * Reprend les demandes en échec, balaie les produits obsolètes, traite la file. Ne modifie jamais stock, commande, réception ni facture ; les corrections ne touchent que les tables cump_*.
 */
export const GET: APIRoute = async ({ request }) => {
  const secret = (import.meta.env.CRON_SECRET ?? process.env.CRON_SECRET ?? '') as string;
  const fourni = request.headers.get('authorization') ?? '';
  if (!secretCronValide(secret, fourni)) return new Response('Non autorisé', { status: 401 });
  const r = await rattrapageCump(supabaseAdmin as any, details =>
    logAdminAction({ adminEmail: 'tâche planifiée', action: 'cump.rattrapage', targetType: 'cump', targetId: 'file', targetLabel: 'Rattrapage quotidien des marges', details }));
  return new Response(JSON.stringify(r), { status: r.ok ? 200 : 503, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
};
