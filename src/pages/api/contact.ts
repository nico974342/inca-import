import type { APIRoute } from 'astro';
import { supabaseAdmin } from '../../lib/supabase';

export const POST: APIRoute = async ({ request }) => {
  const data = await request.formData();
  const nom = (data.get('nom') as string)?.trim();
  const societe = (data.get('societe') as string)?.trim();
  const telephone = (data.get('telephone') as string)?.trim();

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
