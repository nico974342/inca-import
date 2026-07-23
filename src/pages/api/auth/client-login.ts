import type { APIRoute } from 'astro';
import { createAuthClient } from '../../../lib/supabase';
import { getClientIp, isRateLimited, isLoginBlocked, recordFailedLogin, clearFailedLogins } from '../../../lib/rateLimit';

export const POST: APIRoute = async ({ request, cookies, redirect }) => {
  const ip = getClientIp(request);

  if (isLoginBlocked(ip)) {
    return redirect('/connexion/client?error=trop_de_tentatives');
  }

  if (isRateLimited(`clientlogin:${ip}`, 5, 60_000)) {
    return redirect('/connexion/client?error=rate_limit');
  }

  const data = await request.formData();
  const email    = (data.get('email') as string)?.trim();
  const password = data.get('password') as string;

  if (!email || !password) {
    return redirect('/connexion/client?error=champs_requis');
  }

  const supabase = createAuthClient(request, cookies);
  const { data: authData, error } = await supabase.auth.signInWithPassword({ email, password });

  if (error) {
    recordFailedLogin(ip);
    return redirect('/connexion/client?error=identifiants_invalides');
  }

  // Block admin accounts from the client login flow
  if (authData.user?.user_metadata?.role !== 'client') {
    await supabase.auth.signOut();
    recordFailedLogin(ip);
    return redirect('/connexion/client?error=identifiants_invalides');
  }

  clearFailedLogins(ip);
  return redirect('/catalogue');
};
