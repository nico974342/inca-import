import type { APIRoute } from 'astro';
import { createAuthClient, supabaseAdmin } from '../../../lib/supabase';

// products.stock_updated_at n'a jamais existé : schema_v9.sql, qui l'ajoutait,
// n'a jamais été lancé. Les replis qui vivaient ici masquaient l'absence de
// colonne, mais la RPC product_adjust_stock l'écrivait sans repli et échouait
// donc à chaque appel. La colonne et son horodatage sont retirés.
async function listProducts() {
  const { data, error } = await supabaseAdmin
    .from('products')
    .select('id, name, category, sku, stock_quantity, seuil_reappro')
    .order('stock_quantity', { ascending: true })
    .order('name', { ascending: true });

  if (error) console.error('listProducts error:', error);
  return data ?? [];
}

async function setStock(id: string, fields: { stock_quantity: number; in_stock: boolean }) {
  const { error } = await supabaseAdmin.from('products').update(fields).eq('id', id);
  if (error) console.error('setStock error:', error);
}

async function zeroAllStock() {
  const { error } = await supabaseAdmin
    .from('products')
    .update({ stock_quantity: 0, in_stock: false })
    .gte('stock_quantity', 0);
  if (error) console.error('zeroAllStock error:', error);
}

export const GET: APIRoute = async ({ request, cookies }) => {
  const supabase = createAuthClient(request, cookies);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user || user.user_metadata?.role === 'client') {
    return new Response('Non autorisé', { status: 401 });
  }

  const products = await listProducts();
  return new Response(JSON.stringify({ products }), {
    headers: { 'Content-Type': 'application/json' },
  });
};

export const POST: APIRoute = async ({ request, cookies }) => {
  const supabase = createAuthClient(request, cookies);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user || user.user_metadata?.role === 'client') {
    return new Response('Non autorisé', { status: 401 });
  }

  const body = (await request.json().catch(() => null)) as
    | { action?: string; id?: string; delta?: number; value?: number }
    | null;

  if (body?.action === 'zero-all') {
    await zeroAllStock();
  } else if (body?.id && typeof body.value === 'number') {
    // Absolute set — no read needed, single atomic update
    const newQty = Math.max(0, Math.trunc(body.value));
    await setStock(body.id, { stock_quantity: newQty, in_stock: newQty > 0 });
  } else if (body?.id && typeof body.delta === 'number') {
    // Relative adjust — atomic in Postgres, no read-then-write race
    const { error } = await supabaseAdmin.rpc('product_adjust_stock', {
      p_product_id: body.id,
      p_delta: Math.trunc(body.delta),
    });
    if (error) console.error('product_adjust_stock error:', error);
  }

  const products = await listProducts();
  return new Response(JSON.stringify({ products }), {
    headers: { 'Content-Type': 'application/json' },
  });
};
