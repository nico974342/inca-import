/**
 * Best-effort in-memory rate limiting, keyed by client IP.
 * State lives per warm lambda instance only — not shared across
 * concurrent/cold Vercel instances. Good enough to blunt casual
 * abuse; for guaranteed enforcement under real load, back this
 * with an external store (e.g. Upstash Redis) instead.
 */

export function getClientIp(request: Request): string {
  const forwarded = request.headers.get('x-forwarded-for');
  if (forwarded) return forwarded.split(',')[0].trim();
  return request.headers.get('x-real-ip') ?? 'unknown';
}

type Bucket = { count: number; resetAt: number };
const buckets = new Map<string, Bucket>();

/** Generic sliding-window-ish limiter: max `limit` hits per `windowMs` per key. */
export function isRateLimited(key: string, limit: number, windowMs: number): boolean {
  const now = Date.now();
  const bucket = buckets.get(key);

  if (!bucket || now >= bucket.resetAt) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return false;
  }

  bucket.count += 1;
  return bucket.count > limit;
}

type LoginAttempt = { failures: number; blockedUntil: number | null };
const loginAttempts = new Map<string, LoginAttempt>();

const MAX_FAILURES = 5;
const BLOCK_MS = 15 * 60 * 1000;

export function isLoginBlocked(ip: string): boolean {
  const entry = loginAttempts.get(ip);
  if (!entry?.blockedUntil) return false;
  if (Date.now() >= entry.blockedUntil) {
    loginAttempts.delete(ip);
    return false;
  }
  return true;
}

export function recordFailedLogin(ip: string): void {
  const entry = loginAttempts.get(ip) ?? { failures: 0, blockedUntil: null };
  entry.failures += 1;
  if (entry.failures >= MAX_FAILURES) {
    entry.blockedUntil = Date.now() + BLOCK_MS;
  }
  loginAttempts.set(ip, entry);
}

export function clearFailedLogins(ip: string): void {
  loginAttempts.delete(ip);
}
