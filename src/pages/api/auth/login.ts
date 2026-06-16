import type { APIRoute } from 'astro';
import { createAuthClient } from '../../../lib/supabase';
import { getClientIp, isRateLimited, isLoginBlocked, recordFailedLogin, clearFailedLogins } from '../../../lib/rateLimit';

export const POST: APIRoute = async ({ request, cookies, redirect }) => {
  const ip = getClientIp(request);

  if (isLoginBlocked(ip)) {
    return redirect('/admin/login?error=trop_de_tentatives');
  }

  if (isRateLimited(`login:${ip}`, 5, 60_000)) {
    return redirect('/admin/login?error=rate_limit');
  }

  const data = await request.formData();
  const email = (data.get('email') as string)?.trim();
  const password = data.get('password') as string;

  if (!email || !password) {
    return redirect('/admin/login?error=champs_requis');
  }

  const supabase = createAuthClient(request, cookies);
  const { error } = await supabase.auth.signInWithPassword({ email, password });

  if (error) {
    recordFailedLogin(ip);
    return redirect('/admin/login?error=identifiants_invalides');
  }

  clearFailedLogins(ip);

  const userAgent = request.headers.get('user-agent') ?? '';
  const isMobile = /Mobile|iPhone|iPad/i.test(userAgent);

  return redirect(isMobile ? '/admin/commande-rapide' : '/admin');
};
