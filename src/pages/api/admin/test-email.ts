import type { APIRoute } from 'astro';
import { Resend } from 'resend';
import { createAuthClient } from '../../../lib/supabase';

/**
 * Diagnostic endpoint — GET /api/admin/test-email
 *
 * Returns a JSON report of the email configuration and optionally sends
 * a real test email.
 *
 * Query params:
 *   ?send_to=foo@example.com   — send a test email to that address
 *
 * Example: /api/admin/test-email?send_to=incana.gerald@orange.fr
 */
export const GET: APIRoute = async ({ url, request, cookies }) => {
  const supabase = createAuthClient(request, cookies);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user || user.user_metadata?.role === 'client') {
    return new Response('Non autorisé', { status: 401 });
  }

  const API_KEY  = import.meta.env.RESEND_API_KEY as string | undefined;
  const FROM_ENV = import.meta.env.RESEND_FROM   as string | undefined;
  const FROM     = FROM_ENV ?? 'Inca Import <noreply@inca-import.re>';
  const sendTo   = url.searchParams.get('send_to');

  const diag: Record<string, unknown> = {
    timestamp: new Date().toISOString(),
    env: {
      RESEND_API_KEY: API_KEY
        ? `SET (${API_KEY.slice(0, 8)}…)`
        : 'NOT SET ❌',
      RESEND_FROM: FROM_ENV ?? `NOT SET (defaulting to "${FROM}")`,
      resolved_from: FROM,
    },
    send_to: sendTo ?? 'not requested (add ?send_to=your@email.com)',
  };

  if (!API_KEY) {
    return json({ ...diag, result: 'SKIPPED — no API key' }, 200);
  }

  if (!sendTo) {
    return json({ ...diag, result: 'SKIPPED — no send_to param' }, 200);
  }

  const resend = new Resend(API_KEY);
  const subject = `[Test Inca Import] Diagnostic email — ${new Date().toISOString()}`;

  try {
    const result = await resend.emails.send({
      from: FROM,
      to:   [sendTo],
      subject,
      html: `
        <div style="font-family:Helvetica,sans-serif;max-width:500px;padding:24px;color:#1C1917;">
          <h2 style="color:#E55A2B;margin:0 0 12px;">✅ Email de test Inca Import</h2>
          <p>Si vous voyez ceci, la configuration Resend fonctionne correctement.</p>
          <hr style="border:none;border-top:1px solid #EAE6E1;margin:16px 0"/>
          <p style="font-size:12px;color:#9CA3AF;">
            FROM : ${FROM}<br/>
            TO : ${sendTo}<br/>
            KEY : ${API_KEY.slice(0, 8)}…<br/>
            Envoyé à : ${new Date().toISOString()}
          </p>
        </div>
      `,
    });

    diag.result = 'SENT ✅';
    diag.resend_response = result;
  } catch (err: unknown) {
    diag.result = 'ERROR ❌';
    diag.error = err instanceof Error
      ? { message: err.message, name: err.name, stack: err.stack }
      : String(err);
  }

  return json(diag, 200);
};

function json(data: unknown, status: number) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}
