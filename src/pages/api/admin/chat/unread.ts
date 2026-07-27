import type { APIRoute } from 'astro';
import { createAuthClient, supabaseAdmin } from '../../../../lib/supabase';

function json(body: Record<string, unknown>, status: number) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

// Count of messages from OTHER admins since the client's last-seen timestamp
// (tracked in localStorage, not server-side — see AdminLayout's badge script).
export const GET: APIRoute = async ({ request, cookies, url }) => {
  const supabase = createAuthClient(request, cookies);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user || user.user_metadata?.role === 'client') return json({ error: 'Non autorisé' }, 401);

  const since = url.searchParams.get('since');
  if (!since) return json({ count: 0 }, 200);

  const { count, error } = await supabaseAdmin
    .from('admin_messages')
    .select('*', { count: 'exact', head: true })
    .gt('created_at', since)
    .neq('sender_email', user.email ?? '');

  if (error) {
    console.error('[chat/unread] count error:', error.message);
    return json({ count: 0 }, 200);
  }

  return json({ count: count ?? 0 }, 200);
};
