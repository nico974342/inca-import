/// <reference path="../.astro/types.d.ts" />

declare namespace App {
  interface Locals {
    user: import('@supabase/supabase-js').User | null;
  }
}

interface ImportMetaEnv {
  readonly SUPABASE_URL: string;
  readonly SUPABASE_ANON_KEY: string;
  readonly SUPABASE_SERVICE_ROLE_KEY: string;
  readonly RESEND_API_KEY: string;
  readonly MAKE_WEBHOOK_ORDER_URL: string | undefined;
  readonly MAKE_WEBHOOK_CLIENT_URL: string | undefined;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
