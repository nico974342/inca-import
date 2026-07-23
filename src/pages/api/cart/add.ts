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

  const MAX_QTY = 999;
  if (typeof productId !== 'string' || !productId || !Number.isInteger(qty) || qty < 1 || qty > MAX_QTY) {
    return json(400, { error: 'Invalid input' });
  }

  // Validate against available stock; clamp rather than reject so the UI
  // (which already caps client-side) never desyncs from the stored cart.
  const { data: product } = await supabaseAdmin
    .from('products')
    .select('stock_quantity')
    .eq('id', productId)
    .maybeSingle();

  if (!product) return json(404, { error: 'Produit introuvable' });

  const stock = product.stock_quantity ?? 0;
  if (stock < 1) return json(409, { error: 'Rupture de stock', available: 0 });
  const finalQty = Math.min(qty, stock);

  const { error } = await supabaseAdmin.from('cart_items').upsert(
    { user_id: user.id, product_id: productId, quantity: finalQty, updated_at: new Date().toISOString() },
    { onConflict: 'user_id,product_id' }
  );

  if (error) {
    console.error('[cart/add] upsert error:', error.code, error.message);
    return json(500, { error: 'Erreur serveur' });
  }

  return json(200, { ok: true, qty: finalQty });
};
