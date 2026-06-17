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

  // ── Fix 2a: set email for Henrica Incana (client_accounts row id known) ────
  const INCANA_ROW_ID = '2892a415-f2ca-4cc9-855e-9f03be86450c';
  const INCANA_EMAIL  = 'nicolas.incana@groupe-incana.com';

  const { data: incanaAccount } = await supabaseAdmin
    .from('client_accounts')
    .select('id, nom, email, points_de_vente')
    .eq('id', INCANA_ROW_ID)
    .maybeSingle();

  if (!incanaAccount) {
    errors.push(`[fix2a] No client_accounts row found for id=${INCANA_ROW_ID}`);
  } else {
    log.push(`[fix2a] Found: nom="${incanaAccount.nom}", pdv="${incanaAccount.points_de_vente}", current email="${incanaAccount.email}"`);
    if (incanaAccount.email === INCANA_EMAIL) {
      log.push('[fix2a] Email already correct — skipped');
    } else {
      log.push(`[fix2a] Will set client_accounts.email to "${INCANA_EMAIL}"`);
      if (!dryRun) {
        const { error } = await supabaseAdmin
          .from('client_accounts')
          .update({ email: INCANA_EMAIL })
          .eq('id', INCANA_ROW_ID);
        if (error) errors.push(`[fix2a] UPDATE failed: ${error.message} (${error.code})`);
        else log.push('[fix2a] ✓ client_accounts.email updated');
      }
    }
  }

  // ── Fix 2b: patch orders.email for Henrica Incana's confirmed orders ────────
  // When her orders were created, client_accounts.email was null, so orders.email
  // is also null. Email-based PDV matching in livraison.astro won't find them.
  const { data: incanaOrders } = await supabaseAdmin
    .from('orders')
    .select('id, nom, email, status')
    .ilike('nom', '%incana%')
    .eq('status', 'confirmee');

  log.push(`[fix2b] Confirmed orders with nom like '%incana%': ${incanaOrders?.length ?? 0}`);
  for (const o of incanaOrders ?? []) {
    log.push(`  → id=${o.id}, nom="${o.nom}", current email="${o.email}"`);
  }

  const ordersNeedingEmail = (incanaOrders ?? []).filter(o => o.email !== INCANA_EMAIL);
  if (ordersNeedingEmail.length > 0) {
    log.push(`[fix2b] Will update email on ${ordersNeedingEmail.length} order(s)`);
    if (!dryRun) {
      const { error } = await supabaseAdmin
        .from('orders')
        .update({ email: INCANA_EMAIL })
        .in('id', ordersNeedingEmail.map(o => o.id));
      if (error) errors.push(`[fix2b] UPDATE failed: ${error.message} (${error.code})`);
      else log.push('[fix2b] ✓ orders.email updated');
    }
  } else {
    log.push('[fix2b] All matching orders already have correct email — skipped');
  }

  // ── Diagnostic: confirmed orders email vs client_accounts email ─────────────
  const { data: allConfirmed } = await supabaseAdmin
    .from('orders')
    .select('id, nom, email, status')
    .eq('status', 'confirmee');

  const { data: allClients } = await supabaseAdmin
    .from('client_accounts')
    .select('id, nom, email, points_de_vente')
    .not('points_de_vente', 'is', null)
    .neq('points_de_vente', '');

  const clientEmailSet = new Set(
    (allClients ?? []).filter(c => c.email).map(c => (c.email as string).toLowerCase())
  );

  log.push(`\n── Diagnostic (${allConfirmed?.length ?? 0} confirmed orders) ──`);
  for (const o of allConfirmed ?? []) {
    const emailKey = o.email?.toLowerCase();
    const matched = emailKey ? clientEmailSet.has(emailKey) : false;
    log.push(`  ${matched ? '✓' : '✗'} id=${o.id} nom="${o.nom}" email="${o.email ?? '(null)'}" → ${matched ? 'matched' : 'NO MATCH'}`);
  }

  log.push(`\n── client_accounts with PDV (${allClients?.length ?? 0}) ──`);
  for (const c of allClients ?? []) {
    log.push(`  id=${c.id} nom="${c.nom}" pdv="${c.points_de_vente}" email="${c.email ?? '(null)'}"`);
  }

  return new Response(
    JSON.stringify({ dryRun, log, errors }, null, 2),
    { headers: { 'Content-Type': 'application/json' } }
  );
}
