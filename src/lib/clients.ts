import { supabaseAdmin } from './supabase';

/** Canonical form used for storing and comparing client emails. */
export function normalizeEmail(value: string | null | undefined): string {
  return (value ?? '').trim().toLowerCase();
}

// Escape ILIKE wildcards so "jo_n@example.re" can't match "john@example.re".
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (m) => '\\' + m);
}

/**
 * The single way to link an auth user or an order email to a client_accounts
 * row. Case-insensitive so rows stored before email normalization still match.
 */
export async function findClientByEmail<T = Record<string, unknown>>(
  email: string | null | undefined,
  select: string,
): Promise<T | null> {
  const cleaned = normalizeEmail(email);
  if (!cleaned) return null;
  const { data } = await supabaseAdmin
    .from('client_accounts')
    .select(select)
    .ilike('email', escapeLike(cleaned))
    .maybeSingle();
  return (data as T | null) ?? null;
}

/**
 * Resolves the auth.users id behind a client email. `client_accounts` has no
 * user_id column, so email is the only link. Paginated because Supabase caps
 * each listUsers() page.
 */
export async function findAuthUserIdByEmail(email: string | null | undefined): Promise<string | null> {
  const wanted = normalizeEmail(email);
  if (!wanted) return null;

  let page = 1;
  for (;;) {
    const { data: users, error } = await supabaseAdmin.auth.admin.listUsers({ page, perPage: 1000 });
    if (error) throw new Error(`listUsers: ${error.message}`);

    const batch = users?.users ?? [];
    const found = batch.find((u: any) => normalizeEmail(u.email) === wanted);
    if (found) return found.id;
    if (batch.length < 1000) return null;
    page++;
  }
}

/** Applies a client's negotiated discount (percent, 0-100) to a HT price. */
export function applyRemise(priceHt: number | null | undefined, remisePct: number | null | undefined): number | null {
  if (priceHt == null) return null;
  if (!remisePct) return priceHt;
  return Math.round(priceHt * (1 - remisePct / 100) * 10000) / 10000;
}

/**
 * The price group a client actually resolves against: their own if set,
 * otherwise whichever group is marked is_default. Returns null when the
 * client has no group AND no group is default — the caller then falls
 * straight back to products.price_ht, unchanged from before price groups.
 */
export async function resolveEffectiveGroupId(clientPriceGroupId: string | null | undefined): Promise<string | null> {
  if (clientPriceGroupId) return clientPriceGroupId;
  const { data } = await supabaseAdmin
    .from('price_groups')
    .select('id')
    .eq('is_default', true)
    .maybeSingle();
  return data?.id ?? null;
}

/** product_id -> price_ht overrides for one price group. Empty map for a null group. */
export async function fetchPriceGroupOverrides(groupId: string | null): Promise<Map<string, number>> {
  const overrides = new Map<string, number>();
  if (!groupId) return overrides;
  const { data } = await supabaseAdmin
    .from('price_group_items')
    .select('product_id, price_ht')
    .eq('price_group_id', groupId);
  for (const row of data ?? []) overrides.set(row.product_id, Number(row.price_ht));
  return overrides;
}

/** One round trip: resolves the client's effective group, then its price overrides. */
export async function fetchClientPriceOverrides(clientPriceGroupId: string | null | undefined): Promise<Map<string, number>> {
  const groupId = await resolveEffectiveGroupId(clientPriceGroupId);
  return fetchPriceGroupOverrides(groupId);
}

/** Base price adjusted by the price group, before remise — falls back to price_ht when the product has no override line. */
export function resolveGroupPrice(
  productId: string,
  basePriceHt: number | null | undefined,
  overrides: Map<string, number>,
): number | null {
  if (basePriceHt == null) return null;
  return overrides.get(productId) ?? basePriceHt;
}

/** The price a client actually pays for a product: price group, then remise. */
export function resolveClientPrice(
  productId: string,
  basePriceHt: number | null | undefined,
  overrides: Map<string, number>,
  remisePct: number | null | undefined,
): number | null {
  return applyRemise(resolveGroupPrice(productId, basePriceHt, overrides), remisePct);
}
