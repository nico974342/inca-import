import type { APIRoute } from 'astro';
import { supabaseAdmin } from '../../lib/supabase';
import { sanitizeText } from '../../lib/sanitize';
import { getClientIp, isRateLimited } from '../../lib/rateLimit';

export const POST: APIRoute = async ({ request }) => {
  const ip = getClientIp(request);

  if (isRateLimited(`contact:${ip}`, 5, 60_000)) {
    return new Response(JSON.stringify({ error: 'Trop de tentatives, réessayez dans 1 minute' }), {
      status: 429,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const data = await request.formData();
  const nom = sanitizeText(data.get('nom') as string, 120);
  const societe = sanitizeText(data.get('societe') as string, 120);
  const telephone = sanitizeText(data.get('telephone') as string, 30);

  if (!nom || !telephone) {
    return new Response(JSON.stringify({ error: 'Champs requis manquants' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const { error } = await supabaseAdmin
    .from('contact_requests')
    .insert({ nom, societe, telephone });

  if (error) {
    return new Response(JSON.stringify({ error: 'Erreur serveur' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
};
