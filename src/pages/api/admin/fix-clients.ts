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
  // Auth user exists (96dd09bd-6012-487b-9c96-cbc9ea155c74) but row was never
  // created because the inscription.astro insert error was silently swallowed.
  const { data: existing1 } = await supabaseAdmin
    .from('client_accounts')
    .select('id, email, user_id')
    .or('email.eq.henrica.dixneuf@compros.re,user_id.eq.96dd09bd-6012-487b-9c96-cbc9ea155c74')
    .maybeSingle();

  if (existing1) {
    log.push(`[fix1] Henrica Dixneuf already has a client_accounts row (id=${existing1.id}) — skipped`);
  } else {
    log.push('[fix1] No existing row found for Henrica Dixneuf — will insert');
    if (!dryRun) {
      const { error } = await supabaseAdmin.from('client_accounts').insert({
        nom: 'Dixneuf Henrica',
        societe: 'Combox',
        points_de_vente: 'Station st Joseph',
        email: 'henrica.dixneuf@compros.re',
        user_id: '96dd09bd-6012-487b-9c96-cbc9ea155c74',
        status: 'actif',
      });
      if (error) errors.push(`[fix1] INSERT failed: ${error.message} (${error.code})`);
      else log.push('[fix1] ✓ Inserted client_accounts row for Henrica Dixneuf');
    }
  }

  // ── Fix 2: find email for Henrica Incana (Station de l'Hermitage) ──────────
  // client_accounts row has email: null. Look up auth.users by phone in metadata.
  const { data: incanaRow } = await supabaseAdmin
    .from('client_accounts')
    .select('id, nom, email, telephone, user_id, points_de_vente')
    .or('nom.ilike.%incana%,points_de_vente.ilike.%hermitage%')
    .maybeSingle();

  if (!incanaRow) {
    log.push('[fix2] No client_accounts row found for Henrica Incana / Station de l\'Hermitage');
  } else {
    log.push(`[fix2] Found row: id=${incanaRow.id}, nom="${incanaRow.nom}", email="${incanaRow.email}", user_id=${incanaRow.user_id}`);

    if (incanaRow.email) {
      log.push('[fix2] Email already set — skipped');
    } else {
      // Search auth.users for phone +262693485282 in metadata or phone field
      const { data: authData } = await supabaseAdmin.auth.admin.listUsers({ perPage: 1000 });
      const phoneVariants = ['0693485282', '693485282', '+262693485282', '262693485282'];

      const matchedUsers = (authData?.users ?? []).filter(u => {
        const meta = JSON.stringify(u.user_metadata ?? '').toLowerCase();
        const phone = (u.phone ?? '').toLowerCase();
        const emailStr = (u.email ?? '').toLowerCase();
        return (
          phoneVariants.some(p => meta.includes(p) || phone.includes(p)) ||
          meta.includes('incana') ||
          emailStr.includes('incana')
        );
      });

      log.push(`[fix2] Auth.users matching phone/name: ${matchedUsers.length} found`);
      for (const u of matchedUsers) {
        log.push(`  → id=${u.id}, email=${u.email}, metadata=${JSON.stringify(u.user_metadata)}`);
      }

      if (matchedUsers.length === 1 && matchedUsers[0].email) {
        const foundEmail = matchedUsers[0].email;
        log.push(`[fix2] Will update client_accounts.email to "${foundEmail}"`);
        if (!dryRun) {
          const { error } = await supabaseAdmin
            .from('client_accounts')
            .update({ email: foundEmail, user_id: matchedUsers[0].id })
            .eq('id', incanaRow.id);
          if (error) errors.push(`[fix2] UPDATE failed: ${error.message} (${error.code})`);
          else log.push(`[fix2] ✓ Updated email and user_id for Henrica Incana`);
        }
      } else if (matchedUsers.length === 0) {
        log.push('[fix2] No auth.users match found — email must be set manually');
      } else {
        log.push('[fix2] Multiple matches — resolve manually:');
        for (const u of matchedUsers) log.push(`  - ${u.email} (id=${u.id})`);
      }
    }
  }

  return new Response(
    JSON.stringify({ dryRun, log, errors }, null, 2),
    { headers: { 'Content-Type': 'application/json' } }
  );
}
