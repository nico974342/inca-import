import { defineMiddleware } from 'astro:middleware';
import { createAuthClient } from './lib/supabase';

export const onRequest = defineMiddleware(async (context, next) => {
  const path = context.url.pathname;

  // Admin protection — block unauthenticated users and client accounts
  if (path.startsWith('/admin') && path !== '/admin/login') {
    const supabase = createAuthClient(context.request, context.cookies);
    const { data: { user } } = await supabase.auth.getUser();
    if (!user || user.user_metadata?.role === 'client') {
      return context.redirect('/admin/login');
    }

    const ADMIN_TIMEOUT_MS = 8 * 60 * 60 * 1000;
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
    if (user && user.user_metadata?.role !== 'client') {
      return context.redirect('/admin');
    }
  }

  return next();
});
