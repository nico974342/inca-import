import type { APIRoute } from 'astro';
import { createAuthClient } from '../../../lib/supabase';

export const POST: APIRoute = async ({ request, cookies, redirect }) => {
  const data = await request.formData();
  const email    = (data.get('email') as string)?.trim();
  const password = data.get('password') as string;

  if (!email || !password) {
    return redirect('/connexion/client?error=champs_requis');
  }

  const supabase = createAuthClient(request, cookies);
  const { data: authData, error } = await supabase.auth.signInWithPassword({ email, password });

  if (error) {
    return redirect('/connexion/client?error=identifiants_invalides');
  }

  // Block admin accounts from the client login flow
  if (authData.user?.user_metadata?.role !== 'client') {
    await supabase.auth.signOut();
    return redirect('/connexion/client?error=identifiants_invalides');
  }

  return redirect('/catalogue');
};
