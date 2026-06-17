import type { APIRoute } from 'astro';
import { supabaseAdmin } from '../../../lib/supabase';

export const GET: APIRoute = async () => {
  const terms = ['henrica', 'combox'];

  // client_accounts — search nom, societe, email, points_de_vente
  const caQueries = await Promise.all([
    supabaseAdmin.from('client_accounts').select('*').ilike('nom', '%henrica%'),
    supabaseAdmin.from('client_accounts').select('*').ilike('societe', '%henrica%'),
    supabaseAdmin.from('client_accounts').select('*').ilike('email', '%henrica%'),
    supabaseAdmin.from('client_accounts').select('*').ilike('nom', '%combox%'),
    supabaseAdmin.from('client_accounts').select('*').ilike('societe', '%combox%'),
    supabaseAdmin.from('client_accounts').select('*').ilike('points_de_vente', '%combox%'),
    supabaseAdmin.from('client_accounts').select('*').ilike('email', '%combox%'),
  ]);
  const caMap = new Map<string, any>();
  for (const r of caQueries) for (const row of r.data ?? []) caMap.set(row.id, row);
  const clientAccounts = Array.from(caMap.values());

  // orders — search nom, societe, email
  const ordQueries = await Promise.all([
    supabaseAdmin.from('orders').select('id, status, created_at, nom, societe, email, telephone, user_id').ilike('nom', '%henrica%'),
    supabaseAdmin.from('orders').select('id, status, created_at, nom, societe, email, telephone, user_id').ilike('societe', '%henrica%'),
    supabaseAdmin.from('orders').select('id, status, created_at, nom, societe, email, telephone, user_id').ilike('email', '%henrica%'),
    supabaseAdmin.from('orders').select('id, status, created_at, nom, societe, email, telephone, user_id').ilike('nom', '%combox%'),
    supabaseAdmin.from('orders').select('id, status, created_at, nom, societe, email, telephone, user_id').ilike('societe', '%combox%'),
    supabaseAdmin.from('orders').select('id, status, created_at, nom, societe, email, telephone, user_id').ilike('email', '%combox%'),
  ]);
  const ordMap = new Map<string, any>();
  for (const r of ordQueries) for (const row of r.data ?? []) ordMap.set(row.id, row);
  const orders = Array.from(ordMap.values())
    .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());

  // auth.users — only accessible via admin API (supabase.auth.admin)
  const { data: authData, error: authError } = await supabaseAdmin.auth.admin.listUsers({ perPage: 1000 });
  const authUsers = (authData?.users ?? []).filter(u => {
    const s = JSON.stringify(u).toLowerCase();
    return terms.some(t => s.includes(t));
  });

  // If any orders found, also check their user_ids against auth.users
  const orderUserIds = [...new Set(orders.map(o => o.user_id).filter(Boolean))];
  const authByUserId = Object.fromEntries(
    (authData?.users ?? [])
      .filter(u => orderUserIds.includes(u.id))
      .map(u => [u.id, { id: u.id, email: u.email, created_at: u.created_at, user_metadata: u.user_metadata }])
  );

  // Cross-reference: for each client_account, find auth user by email
  const clientEmails = clientAccounts.map(c => c.email).filter(Boolean);
  const authByEmail = Object.fromEntries(
    (authData?.users ?? [])
      .filter(u => clientEmails.includes(u.email))
      .map(u => [u.email, { id: u.id, email: u.email, created_at: u.created_at, confirmed_at: u.confirmed_at, user_metadata: u.user_metadata }])
  );

  const result = {
    client_accounts: {
      count: clientAccounts.length,
      rows: clientAccounts,
    },
    orders: {
      count: orders.length,
      rows: orders,
      auth_users_for_order_user_ids: authByUserId,
    },
    auth_users_matching_terms: {
      count: authUsers.length,
      rows: authUsers.map(u => ({
        id: u.id,
        email: u.email,
        created_at: u.created_at,
        confirmed_at: u.confirmed_at,
        last_sign_in_at: u.last_sign_in_at,
        user_metadata: u.user_metadata,
      })),
    },
    auth_users_for_client_emails: authByEmail,
    _errors: {
      auth: authError?.message ?? null,
    },
  };

  return new Response(JSON.stringify(result, null, 2), {
    headers: { 'Content-Type': 'application/json' },
  });
};
