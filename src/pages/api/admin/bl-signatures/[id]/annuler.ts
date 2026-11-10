import type { APIRoute } from 'astro';
import { supabaseAdmin } from '../../../../../lib/supabase';
import { isAdmin } from '../../../../../lib/roles';

// Annulation EXPLICITE d'une signature (admin uniquement) : motif obligatoire, signature d'origine conservée en base,
// action journalisée. Ce n'est jamais une suppression. Reçoit un formulaire (POST) et renvoie vers la page livraison.
const retour = (message: string, ok: boolean) =>
  new Response(null, { status: 303, headers: { Location: `/admin/livraison?${ok ? 'sig_ok' : 'sig_err'}=${encodeURIComponent(message)}#bons-de-livraison` } });

export const POST: APIRoute = async ({ params, request, locals }) => {
  const user = (locals as any).user;
  if (!user?.email) return new Response('Non autorisé', { status: 401 });
  if (!isAdmin(user)) return retour('Seul un administrateur peut annuler une signature.', false);

  const id = params.id ?? '';
  if (!/^[0-9a-f-]{36}$/i.test(id)) return retour('Signature introuvable.', false);
  const form = await request.formData();
  const motif = String(form.get('motif') ?? '').replace(/\s+/g, ' ').trim().slice(0, 300);
  if (motif.length < 3) return retour("Indiquez le motif de l'annulation (3 caractères minimum).", false);

  const { data: sig } = await supabaseAdmin
    .from('bl_signatures').select('id, role, signataire_nom, delivery_note_id, annulee_le, delivery_notes(delivery_id, pdv_name)').eq('id', id).maybeSingle();
  if (!sig) return retour('Signature introuvable.', false);
  if ((sig as any).annulee_le) return retour('Cette signature est déjà annulée.', false);

  const { error } = await supabaseAdmin
    .from('bl_signatures')
    .update({ annulee_le: new Date().toISOString(), annulee_par: user.email, annulation_motif: motif })
    .eq('id', id)
    .is('annulee_le', null);
  if (error) {
    console.error('[bl_signatures] annulation:', error.message);
    return retour("L'annulation a échoué.", false);
  }

  // Journal : écrit par la base (trigger bl_signatures_journal) dans la même transaction que l'annulation.
  return retour('Signature annulée. Le bon de livraison peut être signé à nouveau.', true);
};
