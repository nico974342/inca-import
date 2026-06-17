import type { APIRoute } from 'astro';
import { supabaseAdmin } from '../../../lib/supabase';

// One-shot data fix — call once then delete this file.
// GET           → dry run: shows what would be changed
// GET ?apply=1  → applies the changes

export const GET: APIRoute = async ({ url }) => {
  const dryRun = url.searchParams.get('apply') !== '1';
  return runFix(dryRun);
};

async function runFix(dryRun: boolean) {
  const log: string[] = [];
  const errors: string[] = [];

  // ── Fix 1: insert missing client_accounts for Henrica Dixneuf ─────────────
  const { data: existing1 } = await supabaseAdmin
    .from('client_accounts')
    .select('id, email')
    .eq('email', 'henrica.dixneuf@compros.re')
    .maybeSingle();

  if (existing1) {
    log.push(`[fix1] Henrica Dixneuf already has a row (id=${existing1.id}) — skipped`);
  } else {
    log.push('[fix1] Will insert client_accounts row for Henrica Dixneuf');
    if (!dryRun) {
      const { error } = await supabaseAdmin.from('client_accounts').insert({
        nom: 'Dixneuf Henrica',
        societe: 'Combox',
        points_de_vente: 'Station st Joseph',
        email: 'henrica.dixneuf@compros.re',
        status: 'actif',
      });
      if (error) errors.push(`[fix1] INSERT failed: ${error.message} (${error.code})`);
      else log.push('[fix1] ✓ Inserted');
    }
  }

  // ── Fix 2: set email for Henrica Incana (id known from confirmed orders) ───
  const TARGET_ID = '2892a415-f2ca-4cc9-855e-9f03be86450c';
  const TARGET_EMAIL = 'nicolas.incana@groupe-incana.com';

  const { data: existing2 } = await supabaseAdmin
    .from('client_accounts')
    .select('id, nom, email, points_de_vente')
    .eq('id', TARGET_ID)
    .maybeSingle();

  if (!existing2) {
    errors.push(`[fix2] No row found for id=${TARGET_ID}`);
  } else {
    log.push(`[fix2] Found: nom="${existing2.nom}", pdv="${existing2.points_de_vente}", current email="${existing2.email}"`);
    if (existing2.email === TARGET_EMAIL) {
      log.push('[fix2] Email already correct — skipped');
    } else {
      log.push(`[fix2] Will set email to "${TARGET_EMAIL}"`);
      if (!dryRun) {
        const { error } = await supabaseAdmin
          .from('client_accounts')
          .update({ email: TARGET_EMAIL })
          .eq('id', TARGET_ID);
        if (error) errors.push(`[fix2] UPDATE failed: ${error.message} (${error.code})`);
        else log.push('[fix2] ✓ Email updated');
      }
    }
  }

  return new Response(
    JSON.stringify({ dryRun, log, errors }, null, 2),
    { headers: { 'Content-Type': 'application/json' } }
  );
}
