import { supabaseAdmin } from './supabase';

export async function logAdminAction(params: {
  adminEmail: string;
  action: string;
  targetType?: string;
  targetId?: string;
  targetLabel?: string;
  details?: Record<string, unknown>;
}) {
  await supabaseAdmin.from('admin_audit_logs').insert({
    admin_email: params.adminEmail,
    action: params.action,
    target_type: params.targetType ?? null,
    target_id: params.targetId ?? null,
    target_label: params.targetLabel ?? null,
    details: params.details ?? null,
  });
}
