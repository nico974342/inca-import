import type { APIRoute } from 'astro';
import { createAuthClient, supabaseAdmin } from '../../../../lib/supabase';

export const POST: APIRoute = async ({ request, cookies }) => {
  const supabase = createAuthClient(request, cookies);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user || user.user_metadata?.role === 'client') {
    return new Response('Non autorisé', { status: 401 });
  }

  const body = (await request.json().catch(() => null)) as
    | { itemIds?: string[]; picked?: boolean }
    | null;

  const itemIds = Array.isArray(body?.itemIds) ? body!.itemIds.filter(Boolean) : [];
  const picked = body?.picked === true;

  if (itemIds.length === 0) {
    return new Response(JSON.stringify({ error: 'itemIds requis' }), { status: 400 });
  }

  const { error } = await supabaseAdmin
    .from('order_items')
    .update({ picked })
    .in('id', itemIds);

  if (error) {
    console.error('[api/preparation/toggle] update error:', error.message);
    return new Response(JSON.stringify({ error: error.message }), { status: 500 });
  }

  return new Response(JSON.stringify({ ok: true }), {
    headers: { 'Content-Type': 'application/json' },
  });
};
