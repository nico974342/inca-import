import { defineMiddleware } from 'astro:middleware';
import { createAuthClient } from './lib/supabase';
import { isStaff } from './lib/roles';

export const onRequest = defineMiddleware(async (context, next) => {
  const path = context.url.pathname;

  // API baseline — these prefixes are staff-only surface area with no page
  // middleware of their own (Astro middleware only runs for page routes it
  // matches by path here, not automatically for /api/*, so each prefix needs
  // its own check). Per-route handlers still gate admin-only actions more
  // precisely; this is the backstop that closes the "route left unguarded"
  // gap rather than the only line of defense.
  if (path.startsWith('/api/admin') || path.startsWith('/api/produits')) {
    const supabase = createAuthClient(context.request, context.cookies);
    const { data: { user } } = await supabase.auth.getUser();
    if (!user || !isStaff(user)) {
      return new Response('Non autorisé', { status: 401 });
    }
    context.locals.user = user;
    return next();
  }

  // Admin protection — block unauthenticated users and client accounts.
  // Passing this gate only means "some staff seat" (admin or commercial) —
  // individual admin-only pages still gate themselves with isAdmin().
  if (path.startsWith('/admin') && path !== '/admin/login') {
    const supabase = createAuthClient(context.request, context.cookies);
    const { data: { user } } = await supabase.auth.getUser();
    if (!user || !isStaff(user)) {
      return context.redirect('/admin/login');
    }

    const ADMIN_TIMEOUT_MS = 30 * 24 * 60 * 60 * 1000;
    const lastActivityRaw = context.cookies.get('admin_last_activity')?.value;
    const lastActivity = lastActivityRaw ? Number(lastActivityRaw) : null;
    const now = Date.now();

    if (lastActivity && now - lastActivity > ADMIN_TIMEOUT_MS) {
      await supabase.auth.signOut();
      context.cookies.delete('admin_last_activity', { path: '/' });
      return context.redirect('/admin/login?error=session_expiree');
    }

    context.cookies.set('admin_last_activity', String(now), {
      path: '/',
      httpOnly: true,
      sameSite: 'lax',
      secure: true,
      maxAge: ADMIN_TIMEOUT_MS / 1000,
    });

    context.locals.user = user;
    return next();
  }

  // Order page — require logged-in client
  if (path.startsWith('/commande')) {
    const supabase = createAuthClient(context.request, context.cookies);
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return context.redirect('/connexion/client');
    context.locals.user = user;
    return next();
  }

  // Landing page — redirect admin users to /admin
  if (path === '/') {
    const supabase = createAuthClient(context.request, context.cookies);
    const { data: { user } } = await supabase.auth.getUser();
    if (isStaff(user)) {
      return context.redirect('/admin');
    }
  }

  return next();
});
