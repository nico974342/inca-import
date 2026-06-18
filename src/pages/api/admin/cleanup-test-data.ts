import type { APIRoute } from 'astro';
import { createAuthClient, supabaseAdmin } from '../../../lib/supabase';

// Auth: admin browser session OR ?key=SERVICE_ROLE_KEY for CLI use
async function isAuthorized(request: Request, cookies: any): Promise<boolean> {
  const url = new URL(request.url);
  const key = url.searchParams.get('key');
  if (key && key === import.meta.env.SUPABASE_SERVICE_ROLE_KEY) return true;

  const supabase = createAuthClient(request, cookies);
  const { data: { user } } = await supabase.auth.getUser();
  return !!user && user.user_metadata?.role !== 'client';
}

async function gatherData() {
  // Paginate auth users (Supabase default page size = 50)
  let allUsers: any[] = [];
  let page = 1;
  while (true) {
    const { data } = await supabaseAdmin.auth.admin.listUsers({ page, perPage: 1000 });
    const batch = data?.users ?? [];
    allUsers = allUsers.concat(batch);
    if (batch.length < 1000) break;
    page++;
  }
  const clientUsers = allUsers.filter(u => u.user_metadata?.role === 'client');

  const [
    { data: orders },
    { data: orderItems },
    { data: clientAccounts },
    { data: deliveryNotes },
    { data: cartItems },
  ] = await Promise.all([
    supabaseAdmin
      .from('orders')
      .select('id, email, nom, societe, status, created_at')
      .order('created_at', { ascending: false }),
    supabaseAdmin
      .from('order_items')
      .select('id, order_id, product_name, quantity'),
    supabaseAdmin
      .from('client_accounts')
      .select('id, nom, email, societe, telephone, status, points_de_vente, created_at')
      .order('created_at', { ascending: false }),
    supabaseAdmin
      .from('delivery_notes')
      .select('id, delivery_id, pdv_name, created_at')
      .order('created_at', { ascending: false }),
    supabaseAdmin
      .from('cart_items')
      .select('id, user_id, quantity'),
  ]);

  return { clientUsers, orders, orderItems, clientAccounts, deliveryNotes, cartItems };
}

// ── GET: dry run ─────────────────────────────────────────────────
export const GET: APIRoute = async ({ request, cookies }) => {
  if (!(await isAuthorized(request, cookies))) {
    return new Response('Non autorisé', { status: 401 });
  }

  const { clientUsers, orders, orderItems, clientAccounts, deliveryNotes, cartItems } = await gatherData();

  const result = {
    mode: 'dry-run — nothing deleted',
    summary: {
      auth_users_role_client: clientUsers.length,
      client_accounts:        clientAccounts?.length ?? 0,
      orders:                 orders?.length ?? 0,
      order_items:            orderItems?.length ?? 0,
      delivery_notes:         deliveryNotes?.length ?? 0,
      cart_items:             cartItems?.length ?? 0,
    },
    detail: {
      auth_users: clientUsers.map(u => ({
        id:         u.id,
        email:      u.email,
        created_at: u.created_at,
      })),
      client_accounts: (clientAccounts ?? []).map(c => ({
        id:              c.id,
        nom:             c.nom,
        email:           c.email,
        societe:         c.societe ?? null,
        points_de_vente: c.points_de_vente ?? null,
        status:          c.status,
        created_at:      c.created_at,
      })),
      orders: (orders ?? []).map(o => ({
        id:         o.id,
        email:      o.email,
        nom:        o.nom,
        societe:    o.societe ?? null,
        status:     o.status,
        created_at: o.created_at,
      })),
      order_items_count_by_order: Object.entries(
        (orderItems ?? []).reduce<Record<string, number>>((acc, i) => {
          acc[i.order_id] = (acc[i.order_id] ?? 0) + 1;
          return acc;
        }, {})
      ).map(([order_id, count]) => ({ order_id, count })),
      delivery_notes: (deliveryNotes ?? []).map(n => ({
        id:          n.id,
        delivery_id: n.delivery_id,
        pdv_name:    n.pdv_name,
        created_at:  n.created_at,
      })),
    },
  };

  return new Response(JSON.stringify(result, null, 2), {
    headers: { 'Content-Type': 'application/json' },
  });
};

// ── POST ?apply=1: actually delete ───────────────────────────────
export const POST: APIRoute = async ({ request, cookies }) => {
  if (!(await isAuthorized(request, cookies))) {
    return new Response('Non autorisé', { status: 401 });
  }

  const url = new URL(request.url);
  if (url.searchParams.get('apply') !== '1') {
    return new Response(
      JSON.stringify({ error: 'Add ?apply=1 to confirm deletion' }),
      { status: 400, headers: { 'Content-Type': 'application/json' } },
    );
  }

  const { clientUsers, orders, orderItems, clientAccounts, deliveryNotes, cartItems } = await gatherData();
  const deleted: Record<string, number> = {};
  const errors: string[] = [];

  // 1. cart_items (FK → auth.users)
  if (cartItems?.length) {
    const { error, count } = await supabaseAdmin
      .from('cart_items')
      .delete({ count: 'exact' })
      .neq('id', '00000000-0000-0000-0000-000000000000'); // delete all
    if (error) errors.push(`cart_items: ${error.message}`);
    else deleted.cart_items = count ?? cartItems.length;
  }

  // 2. order_items (FK → orders)
  if (orderItems?.length) {
    const orderIds = (orders ?? []).map(o => o.id);
    if (orderIds.length) {
      const { error, count } = await supabaseAdmin
        .from('order_items')
        .delete({ count: 'exact' })
        .in('order_id', orderIds);
      if (error) errors.push(`order_items: ${error.message}`);
      else deleted.order_items = count ?? orderItems.length;
    }
  }

  // 3. orders
  if (orders?.length) {
    const { error, count } = await supabaseAdmin
      .from('orders')
      .delete({ count: 'exact' })
      .neq('id', '00000000-0000-0000-0000-000000000000');
    if (error) errors.push(`orders: ${error.message}`);
    else deleted.orders = count ?? orders.length;
  }

  // 4. delivery_notes
  if (deliveryNotes?.length) {
    const { error, count } = await supabaseAdmin
      .from('delivery_notes')
      .delete({ count: 'exact' })
      .neq('id', '00000000-0000-0000-0000-000000000000');
    if (error) errors.push(`delivery_notes: ${error.message}`);
    else deleted.delivery_notes = count ?? deliveryNotes.length;
  }

  // 5. client_accounts
  if (clientAccounts?.length) {
    const { error, count } = await supabaseAdmin
      .from('client_accounts')
      .delete({ count: 'exact' })
      .neq('id', '00000000-0000-0000-0000-000000000000');
    if (error) errors.push(`client_accounts: ${error.message}`);
    else deleted.client_accounts = count ?? clientAccounts.length;
  }

  // 6. auth.users with role = 'client' (one by one — no bulk delete in Supabase admin API)
  let deletedUsers = 0;
  for (const u of clientUsers) {
    const { error } = await supabaseAdmin.auth.admin.deleteUser(u.id);
    if (error) errors.push(`auth.user ${u.email}: ${error.message}`);
    else deletedUsers++;
  }
  deleted.auth_users_client = deletedUsers;

  return new Response(
    JSON.stringify({ deleted, errors: errors.length ? errors : undefined }, null, 2),
    { headers: { 'Content-Type': 'application/json' } },
  );
};
