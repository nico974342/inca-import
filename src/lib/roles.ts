/**
 * Single source of truth for role checks. The role lives in
 * app_metadata.role ('admin' | 'commercial' | 'client') — never
 * user_metadata, which the user themselves can overwrite via the Supabase
 * client SDK (auth.updateUser()). app_metadata can only be written with the
 * service_role key, i.e. from our own server code, never by the account
 * holder. Use isAdmin() for admin-only actions/pages and isStaff() for
 * anything a commercial should also reach.
 */
export type UserRole = 'admin' | 'commercial' | 'client';

// The index signature matters, not just cosmetic: Supabase's real
// UserAppMetadata type is itself `{ provider?, providers?, [key: string]: any }`.
// Without a matching index signature here, TS treats this as a "weak type"
// with zero properties in common with the real one and refuses the
// assignment at every call site that passes a properly-typed User (as
// opposed to the `(Astro.locals as any).user` cast used elsewhere).
type MetaUser = { app_metadata?: { role?: string | null; [key: string]: any } | null } | null | undefined;

const ROLES: readonly UserRole[] = ['admin', 'commercial', 'client'];

export function getRole(user: MetaUser): UserRole | null {
  if (!user) return null;
  const r = user.app_metadata?.role;
  if ((ROLES as readonly string[]).includes(r as string)) return r as UserRole;
  // A missing, empty, or unrecognized role resolves to 'client' — the
  // least-privileged real role, never 'admin'. This used to default to
  // 'admin' (to avoid locking out a legacy account with no role field);
  // that was itself the vulnerability an external audit flagged, since
  // app_metadata being unset is indistinguishable from a role having been
  // stripped or never assigned. Every account that should be staff now has
  // an explicit app_metadata.role written by the role migration — nothing
  // should ever legitimately hit this fallback and need admin access.
  return 'client';
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
