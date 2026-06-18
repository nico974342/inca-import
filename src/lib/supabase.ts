import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { createServerClient, parseCookieHeader } from '@supabase/ssr';
import type { AstroCookies } from 'astro';

// Defers createClient() until first property access — safe during prerender
// when env vars aren't available yet.
function lazyClient(init: () => SupabaseClient): SupabaseClient {
  let client: SupabaseClient | undefined;
  return new Proxy({} as SupabaseClient, {
    get(_, prop: string) {
      if (!client) client = init();
      const val = (client as any)[prop];
      return typeof val === 'function' ? val.bind(client) : val;
    },
  });
}

// Server-only: bypasses RLS — use in admin pages
export const supabaseAdmin = lazyClient(() =>
  createClient(
    import.meta.env.SUPABASE_URL,
    import.meta.env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { autoRefreshToken: false, persistSession: false } }
  )
);

// Public read client (anon key, RLS enforced)
export const supabasePublic = lazyClient(() =>
  createClient(
    import.meta.env.SUPABASE_URL,
    import.meta.env.SUPABASE_ANON_KEY,
    { auth: { autoRefreshToken: false, persistSession: false } }
  )
);

// Auth client — manages session cookies for the admin login flow.
// Reads from the raw Cookie header (Astro v6 has no cookies.getAll()),
// writes via cookies.set() which sets response headers.
export function createAuthClient(request: Request, cookies: AstroCookies) {
  return createServerClient(
    import.meta.env.SUPABASE_URL,
    import.meta.env.SUPABASE_ANON_KEY,
    {
      cookies: {
        getAll() {
          return parseCookieHeader(request.headers.get('cookie') ?? '');
        },
        setAll(toSet) {
          // 30-day maxAge ensures cookies survive PWA/browser restarts on iPhone
          toSet.forEach(({ name, value, options }) =>
            cookies.set(name, value, { maxAge: 30 * 24 * 60 * 60, ...options })
          );
        },
      },
    }
  );
}
