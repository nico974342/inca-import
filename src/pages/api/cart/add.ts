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

  let productId: string, qty: number;
  try {
    const body = await request.json();
    productId = body.productId;
    qty       = Number(body.qty);
  } catch {
    return json(400, { error: 'Invalid JSON' });
  }

  if (!productId || !Number.isInteger(qty) || qty < 1) {
    return json(400, { error: 'Invalid input' });
  }

  const { error } = await supabaseAdmin.from('cart_items').upsert(
    { user_id: user.id, product_id: productId, quantity: qty, updated_at: new Date().toISOString() },
    { onConflict: 'user_id,product_id' }
  );

  if (error) return json(500, { error: error.message });

  return json(200, { ok: true });
};
