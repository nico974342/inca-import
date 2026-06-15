import type { APIRoute } from 'astro';
import { createAuthClient } from '../../../lib/supabase';

export const POST: APIRoute = async ({ request, cookies, redirect }) => {
  const data = await request.formData();
  const email = (data.get('email') as string)?.trim();
  const password = data.get('password') as string;

  if (!email || !password) {
    return redirect('/admin/login?error=champs_requis');
  }

  const supabase = createAuthClient(request, cookies);
  const { error } = await supabase.auth.signInWithPassword({ email, password });

  if (error) {
    return redirect('/admin/login?error=identifiants_invalides');
  }

  return redirect('/admin');
};
