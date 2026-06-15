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
