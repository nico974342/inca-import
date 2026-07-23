import type { APIRoute } from 'astro';
import { createAuthClient, supabaseAdmin } from '../../../lib/supabase';

// stock_updated_at only exists once schema_v9.sql has been run — fall back
// gracefully so the page still works (without timestamps) before that migration runs.
let hasStockUpdatedAt = true;

async function listProducts() {
  if (hasStockUpdatedAt) {
    const { data, error } = await supabaseAdmin
      .from('products')
      .select('id, name, category, sku, stock_quantity, stock_updated_at')
      .order('stock_quantity', { ascending: true })
      .order('name', { ascending: true });

    if (!error) return data ?? [];
    if (error.code !== '42703') console.error('listProducts error:', error);
    hasStockUpdatedAt = false;
  }

  const { data, error } = await supabaseAdmin
    .from('products')
    .select('id, name, category, sku, stock_quantity')
    .order('stock_quantity', { ascending: true })
    .order('name', { ascending: true });

  if (error) console.error('listProducts error:', error);
  return (data ?? []).map((p) => ({ ...p, stock_updated_at: null }));
}

async function touchStock(id: string, fields: { stock_quantity: number; in_stock: boolean }) {
  if (hasStockUpdatedAt) {
    const { error } = await supabaseAdmin
      .from('products')
      .update({ ...fields, stock_updated_at: new Date().toISOString() })
      .eq('id', id);

    if (!error) return;
    if (error.code !== '42703') console.error('touchStock error:', error);
    hasStockUpdatedAt = false;
  }

  const { error } = await supabaseAdmin.from('products').update(fields).eq('id', id);
  if (error) console.error('touchStock error:', error);
}

async function zeroAllStock() {
  if (hasStockUpdatedAt) {
    const { error } = await supabaseAdmin
      .from('products')
      .update({ stock_quantity: 0, in_stock: false, stock_updated_at: new Date().toISOString() })
      .gte('stock_quantity', 0);

    if (!error) return;
    if (error.code !== '42703') console.error('zeroAllStock error:', error);
    hasStockUpdatedAt = false;
  }

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
    await touchStock(body.id, { stock_quantity: newQty, in_stock: newQty > 0 });
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
