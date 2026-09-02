import type { APIRoute } from 'astro';
import { createAuthClient, supabaseAdmin } from '../../../../lib/supabase';
import { isStaff } from '../../../../lib/roles';

const MAX_MESSAGES = 200;
const MAX_LENGTH = 2000;

function json(body: Record<string, unknown>, status: number) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

async function requireStaff(request: Request, cookies: any) {
  const supabase = createAuthClient(request, cookies);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user || !isStaff(user)) return null;
  return user;
}

// Full refetch every poll — simplest option for a two-person internal chat,
// no cursor/delta tracking needed at this volume.
export const GET: APIRoute = async ({ request, cookies }) => {
  const user = await requireStaff(request, cookies);
  if (!user) return json({ error: 'Non autorisé' }, 401);

  const { data, error } = await supabaseAdmin
    .from('admin_messages')
    .select('id, sender_email, content, created_at')
    .order('created_at', { ascending: false })
    .limit(MAX_MESSAGES);

  if (error) {
    console.error('[chat/messages] fetch error:', error.message);
    return json({ error: 'Erreur lors du chargement des messages.' }, 500);
  }

  return json({ messages: (data ?? []).reverse() }, 200);
};

export const POST: APIRoute = async ({ request, cookies }) => {
  const user = await requireStaff(request, cookies);
  if (!user || !user.email) return json({ error: 'Non autorisé' }, 401);

  const body = await request.json().catch(() => null) as { content?: string } | null;
  const content = body?.content?.trim().slice(0, MAX_LENGTH);
  if (!content) return json({ error: 'Message vide.' }, 400);

  const { data, error } = await supabaseAdmin
    .from('admin_messages')
    .insert({ sender_email: user.email, content })
    .select('id, sender_email, content, created_at')
    .single();

  if (error) {
    console.error('[chat/messages] insert error:', error.message);
    return json({ error: "Erreur lors de l'envoi du message." }, 500);
  }

  return json({ message: data }, 201);
};
