import type { APIRoute } from 'astro';
import { supabaseAdmin } from '../../../lib/supabase';

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

export const GET: APIRoute = async () => {
  const products = await listProducts();
  return new Response(JSON.stringify({ products }), {
    headers: { 'Content-Type': 'application/json' },
  });
};

export const POST: APIRoute = async ({ request }) => {
  const body = (await request.json().catch(() => null)) as
    | { action?: string; id?: string; delta?: number; value?: number }
    | null;

  if (body?.action === 'zero-all') {
    await zeroAllStock();
  } else if (body?.id && (typeof body.delta === 'number' || typeof body.value === 'number')) {
    const { id } = body;
    const { data: prod, error } = await supabaseAdmin
      .from('products')
      .select('stock_quantity')
      .eq('id', id)
      .single();

    if (error) console.error('fetch product error:', error);

    if (prod) {
      const newQty =
        typeof body.value === 'number'
          ? Math.max(0, Math.trunc(body.value))
          : Math.max(0, prod.stock_quantity + (body.delta ?? 0));

      await touchStock(id, { stock_quantity: newQty, in_stock: newQty > 0 });
    }
  }

  const products = await listProducts();
  return new Response(JSON.stringify({ products }), {
    headers: { 'Content-Type': 'application/json' },
  });
};
