import type { APIRoute } from 'astro';
import { createAuthClient, supabaseAdmin } from '../../../lib/supabase';
import { logAdminAction } from '../../../lib/audit';

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

/**
 * Les trois chemins d'ajustement manuel du stock — c'était le seul type
 * d'action admin non journalisé, et précisément celui où un historique s'est
 * perdu en silence (product_adjust_stock a longtemps échoué sans jamais
 * l'enregistrer nulle part). On ne journalise qu'en cas de succès : un
 * ajustement qui n'a pas eu lieu n'a pas d'ancienne/nouvelle valeur à tracer.
 */
async function logStockAdjustment(
  adminEmail: string,
  targetId: string | null,
  targetLabel: string,
  details: Record<string, unknown>,
) {
  await logAdminAction({
    adminEmail,
    action: 'produit.stock_ajustement',
    targetType: 'product',
    targetId: targetId ?? undefined,
    targetLabel,
    details,
  });
}

async function setStock(id: string, fields: { stock_quantity: number; in_stock: boolean }) {
  const { error } = await supabaseAdmin.from('products').update(fields).eq('id', id);
  if (error) console.error('setStock error:', error);
  return !error;
}

async function zeroAllStock() {
  const { error } = await supabaseAdmin
    .from('products')
    .update({ stock_quantity: 0, in_stock: false })
    .gte('stock_quantity', 0);
  if (error) console.error('zeroAllStock error:', error);
  return !error;
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
  const adminEmail = user.email ?? 'inconnu';

  const body = (await request.json().catch(() => null)) as
    | { action?: string; id?: string; delta?: number; value?: number }
    | null;

  if (body?.action === 'zero-all') {
    // Snapshot avant écriture : seuls les produits qui avaient réellement du
    // stock sont dignes d'être tracés, pas les 0 → 0 déjà à zéro.
    const { data: before } = await supabaseAdmin
      .from('products')
      .select('id, name, stock_quantity')
      .gt('stock_quantity', 0);

    if (await zeroAllStock()) {
      if (before && before.length > 0) {
        await logStockAdjustment(adminEmail, null, `${before.length} produits`, {
          method: 'tout_a_zero',
          count: before.length,
          produits: before.map(p => ({ id: p.id, name: p.name, avant: p.stock_quantity, apres: 0 })),
        });
      }
    }
  } else if (body?.id && typeof body.value === 'number') {
    const { data: before } = await supabaseAdmin
      .from('products').select('name, stock_quantity').eq('id', body.id).single();

    // Absolute set — no read needed, single atomic update
    const newQty = Math.max(0, Math.trunc(body.value));
    if (await setStock(body.id, { stock_quantity: newQty, in_stock: newQty > 0 })) {
      if (before && before.stock_quantity !== newQty) {
        await logStockAdjustment(adminEmail, body.id, before.name, {
          method: 'saisie_directe',
          avant: before.stock_quantity,
          apres: newQty,
        });
      }
    }
  } else if (body?.id && typeof body.delta === 'number') {
    const { data: before } = await supabaseAdmin
      .from('products').select('name, stock_quantity').eq('id', body.id).single();

    // Relative adjust — atomic in Postgres, no read-then-write race. La
    // valeur « avant » lue juste au-dessus est un instantané pour le
    // journal, pas la source de vérité : c'est la RPC, non ce read, qui
    // garantit l'absence de race sur stock_quantity lui-même.
    const { data: newQty, error } = await supabaseAdmin.rpc('product_adjust_stock', {
      p_product_id: body.id,
      p_delta: Math.trunc(body.delta),
    });
    if (error) {
      console.error('product_adjust_stock error:', error);
    } else if (before) {
      await logStockAdjustment(adminEmail, body.id, before.name, {
        method: 'boutons',
        delta: Math.trunc(body.delta),
        avant: before.stock_quantity,
        apres: newQty,
      });
    }
  }

  const products = await listProducts();
  return new Response(JSON.stringify({ products }), {
    headers: { 'Content-Type': 'application/json' },
  });
};
