import type { APIRoute } from 'astro';
import { supabaseAdmin } from '../../../../lib/supabase';
import { fetchSignaturesActives, etatDuBl } from '../../../../lib/blSignatures';
import { estRoleSignature, validerImageSignature, validerNom, LIBELLE_ROLE } from '../../../../lib/signatureBl';

// Admin ET commercial (le middleware filtre déjà /api/admin sur isStaff). Un client ne peut jamais signer.
// Enregistre UNE signature ; jamais de modification ni de suppression (voir la migration bl_signatures.sql).
const json = (corps: unknown, status = 200) =>
  new Response(JSON.stringify(corps), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });

export const POST: APIRoute = async ({ request, locals }) => {
  const user = (locals as any).user;
  if (!user?.email) return json({ ok: false, erreur: 'Non autorisé.' }, 401);

  if (Number(request.headers.get('content-length') ?? 0) > 600_000) return json({ ok: false, erreur: 'Requête trop volumineuse.' }, 413);
  let corps: any;
  try { corps = await request.json(); } catch { return json({ ok: false, erreur: 'Requête invalide.' }, 400); }

  const noteId = typeof corps?.delivery_note_id === 'string' ? corps.delivery_note_id : '';
  if (!/^[0-9a-f-]{36}$/i.test(noteId)) return json({ ok: false, erreur: 'Bon de livraison introuvable.' }, 400);
  if (!estRoleSignature(corps?.role)) return json({ ok: false, erreur: 'Rôle de signature invalide.' }, 400);
  const role = corps.role;
  const nom = validerNom(corps?.signataire_nom);
  if (!nom.ok) return json({ ok: false, erreur: nom.raison }, 400);
  const image = validerImageSignature(corps?.signature_data);
  if (!image.ok) return json({ ok: false, erreur: image.raison }, 400);

  const { data: note } = await supabaseAdmin
    .from('delivery_notes').select('id, delivery_id, pdv_name, contenu').eq('id', noteId).maybeSingle();
  if (!note) return json({ ok: false, erreur: 'Bon de livraison introuvable.' }, 404);
  if (!(note as any).contenu) {
    return json({ ok: false, erreur: 'Ce bon de livraison est antérieur à la signature électronique : il ne peut pas être signé ici.' }, 409);
  }

  const actives = (await fetchSignaturesActives([noteId])).get(noteId) ?? [];
  if (role === 'destinataire' && !actives.some(s => s.role === 'transporteur')) {
    return json({ ok: false, erreur: 'Le transporteur doit signer en premier.' }, 409);
  }

  // signed_at est posé par la base ; signed_by vient de la session, jamais du navigateur.
  const { data: cree, error } = await supabaseAdmin
    .from('bl_signatures')
    .insert({ delivery_note_id: noteId, role, signature_data: image.data, signataire_nom: nom.nom, signed_by: user.email })
    .select('id, signed_at')
    .single();

  if (error) {
    if (error.code === '23505') {
      // Nouvel essai après une réponse perdue : si c'est exactement la même signature, elle est bien enregistrée.
      const { data: existante } = await supabaseAdmin
        .from('bl_signatures').select('signature_data, signataire_nom').eq('delivery_note_id', noteId).eq('role', role).is('annulee_le', null).maybeSingle();
      if (existante && (existante as any).signature_data === image.data && (existante as any).signataire_nom === nom.nom) {
        const etat = etatDuBl((await fetchSignaturesActives([noteId])).get(noteId));
        return json({ ok: true, deja_enregistree: true, etat });
      }
      return json({ ok: false, erreur: `Le ${LIBELLE_ROLE[role].toLowerCase()} a déjà signé ce bon de livraison.` }, 409);
    }
    console.error('[bl_signatures] insertion:', error.message);
    return json({ ok: false, erreur: "La signature n'a pas pu être enregistrée. Réessayez." }, 500);
  }

  // Journal : écrit par la base (trigger bl_signatures_journal) dans la même transaction que la signature,
  // donc impossible d'avoir une signature sans trace dans admin_audit_logs.
  const etat = etatDuBl((await fetchSignaturesActives([noteId])).get(noteId));
  return json({ ok: true, etat, signed_at: (cree as any).signed_at });
};
