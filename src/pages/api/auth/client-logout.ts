import type { APIRoute } from 'astro';
import { createAuthClient } from '../../../lib/supabase';

export const POST: APIRoute = async ({ request, cookies, redirect }) => {
  const supabase = createAuthClient(request, cookies);
  await supabase.auth.signOut();
  return redirect('/catalogue');
};
