/**
 * Single source of truth for role checks. The role lives in
 * user_metadata.role ('admin' | 'commercial' | 'client') — never derive
 * authorization from "not a client", which silently grants every future
 * role admin-level access. Use isAdmin() for admin-only actions/pages and
 * isStaff() for anything a commercial should also reach.
 */
export type UserRole = 'admin' | 'commercial' | 'client';

type MetaUser = { user_metadata?: { role?: string | null } | null } | null | undefined;

const ROLES: readonly UserRole[] = ['admin', 'commercial', 'client'];

export function getRole(user: MetaUser): UserRole | null {
  if (!user) return null;
  const r = user.user_metadata?.role;
  if ((ROLES as readonly string[]).includes(r as string)) return r as UserRole;
  // Accounts created before the role field existed (or via the Supabase
  // dashboard directly) have no role set at all. The old authorization
  // shortcut ("anything that isn't 'client' is staff") treated every one of
  // them as a full admin — defaulting an unrecognized/missing role to
  // 'admin' here preserves that instead of silently locking them out.
  return 'admin';
}

export function isAdmin(user: MetaUser): boolean {
  return getRole(user) === 'admin';
}

export function isCommercial(user: MetaUser): boolean {
  return getRole(user) === 'commercial';
}

export function isClientRole(user: MetaUser): boolean {
  return getRole(user) === 'client';
}

/** Admin or commercial — any staff account with a seat in /admin, as opposed to a client. */
export function isStaff(user: MetaUser): boolean {
  const r = getRole(user);
  return r === 'admin' || r === 'commercial';
}

export const ROLE_LABEL: Record<UserRole, string> = {
  admin: 'Admin',
  commercial: 'Commercial',
  client: 'Client',
};
