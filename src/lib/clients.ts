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

/** Applies a client's negotiated discount (percent, 0-100) to a HT price. */
export function applyRemise(priceHt: number | null | undefined, remisePct: number | null | undefined): number | null {
  if (priceHt == null) return null;
  if (!remisePct) return priceHt;
  return Math.round(priceHt * (1 - remisePct / 100) * 10000) / 10000;
}
