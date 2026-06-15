import type { APIRoute } from 'astro';
import { createAuthClient, supabaseAdmin } from '../../../lib/supabase';

export const POST: APIRoute = async ({ request, cookies }) => {
  const json = (status: number, body: object) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });

  const supabase = createAuthClient(request, cookies);
  const { data: { user } } = await supabase.auth.getUser();

  if (!user || user.user_metadata?.role !== 'client') {
    return json(401, { error: 'Unauthorized' });
  }

  let productId: string;
  try {
    const body = await request.json();
    productId = body.productId;
  } catch {
    return json(400, { error: 'Invalid JSON' });
  }

  if (!productId) return json(400, { error: 'Missing productId' });

  await supabaseAdmin.from('cart_items').delete()
    .eq('user_id', user.id)
    .eq('product_id', productId);

  return json(200, { ok: true });
};
