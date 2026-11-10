import type { APIRoute } from 'astro';
import { supabaseAdmin } from '../../../../../lib/supabase';
import { logAdminAction } from '../../../../../lib/audit';
import { findClientByEmail } from '../../../../../lib/clients';
import { todayReunion } from '../../../../../lib/datetime';
import { verifierStockageBl, creerBons } from '../../../../../lib/blStockage';
import { depotBl, fetchBlsDesCommandes } from '../../../../../lib/blSignatures';
import { cleOperationCommande, construireContenuCommande, empreinteCommande, estUuid, pdvKeyCommande } from '../../../../../lib/blCommande';

/**
 * Création EXPLICITE du BL d'une commande (bouton « Générer le BL » de la fiche Commandes).
 *  - POST uniquement : un simple GET, un rafraîchissement ou un lien ne crée jamais rien et ne consomme aucun numéro ;
 *  - idempotent : une même commande ne reçoit qu'un seul BL « complet » (clé d'opération), le double clic renvoie le même BL ;
 *  - n'envoie AUCUN e-mail, ne change ni le statut, ni les stocks, ni la facturation de la commande ;
 *  - un BL est figé dès sa création (numéro, lignes, client, point de vente) et rattaché à la commande par son identifiant.
 * Admin et commercial (le middleware filtre déjà /api/admin sur isStaff).
 */
const retour = (id: string, ok: boolean, message: string) =>
  new Response(null, { status: 303, headers: { Location: `/admin/commandes?${ok ? 'bl_ok' : 'bl_err'}=${encodeURIComponent(message)}&ouvrir=${id}#cmd-${id}` } });

export const POST: APIRoute = async ({ params, locals }) => {
  const user = (locals as any).user;
  if (!user?.email) return new Response('Non autorisé', { status: 401 });
  const id = params.id ?? '';
  if (!estUuid(id)) return new Response('Non trouvé', { status: 404 });

  const pret = await verifierStockageBl(depotBl);
  if (!pret.ok) return retour(id, false, pret.message);

  const { data: order } = await supabaseAdmin
    .from('orders').select('id, status, nom, societe, email, telephone, bl_number').eq('id', id).maybeSingle();
  if (!order) return retour(id, false, 'Commande introuvable.');
  if (order.status === 'annulee') return retour(id, false, 'Commande annulée : aucun BL ne peut être généré.');

  // BL déjà établi pour cette commande : on le retrouve, on n'en crée pas un second (aucun numéro consommé)
  const existants = (await fetchBlsDesCommandes([id])).get(id) ?? [];
  if (existants.length > 0) return retour(id, true, `Cette commande a déjà un BL (${existants[0].numero}) : aucun nouveau numéro n'a été consommé.`);

  // Ancien BL (numéro porté par la commande, signé sur papier) : on ne le régénère jamais
  if ((order as any).bl_number) {
    return retour(id, false, `Cette commande a déjà un ancien BL (${(order as any).bl_number}), signé sur papier : aucun nouveau BL n'est généré.`);
  }

  const { data: lignes } = await supabaseAdmin
    .from('order_items')
    .select('product_name, quantity, unit, price_ht_snapshot, tva_rate_snapshot, products(sku, units_per_carton)')
    .eq('order_id', id);
  if (!lignes || lignes.length === 0) return retour(id, false, 'Cette commande ne contient aucun article : aucun BL généré.');

  // Données client pour l'adresse et le point de vente (affichage seulement : la liaison du BL se fait par l'identifiant de commande)
  const CLIENT_SELECT = 'id, nom, societe, points_de_vente, livraison_rue, livraison_ville, livraison_code_postal, adresse_pdv, facturation_same, facturation_rue, facturation_code_postal, facturation_ville';
  let client: any = await findClientByEmail(order.email, CLIENT_SELECT);
  if (!client && order.nom) {
    const { data } = await supabaseAdmin.from('client_accounts').select(CLIENT_SELECT).ilike('nom', order.nom.trim()).maybeSingle();
    client = data;
  }

  const contenu = construireContenuCommande(
    { nom: order.nom, societe: order.societe },
    (lignes as any[]).map(l => ({ ...l, sku: l.products?.sku ?? null, units_per_carton: l.products?.units_per_carton ?? null })),
    client,
    todayReunion(),
  );

  const res = await creerBons(depotBl, [{
    cle: cleOperationCommande(id),
    clientId: client?.id ?? null,
    pdvKey: pdvKeyCommande(id),
    pdvName: contenu.pdv.name,
    contenu,
    commandes: [{ order_id: id, empreinte: empreinteCommande(lignes as any[]) }],
  }]);
  if (!res.ok) { console.error('[bl] création depuis la commande:', res.message); return retour(id, false, res.message); }

  const bl = res.bons[0];
  if (bl.cree) {
    await logAdminAction({
      adminEmail: user.email, action: 'bl.creation', targetType: 'order', targetId: id,
      targetLabel: `${bl.numero} — ${contenu.pdv.name}`,
      details: { bl_id: bl.id, numero: bl.numero, cle_operation: bl.cle, commandes: [id] },
    });
  }
  return retour(id, true, bl.cree
    ? `BL ${bl.numero} enregistré pour cette commande. Aucun e-mail n'a été envoyé.`
    : `Cette commande a déjà un BL (${bl.numero}) : aucun nouveau numéro n'a été consommé.`);
};

// Aucune création par GET (lien, rafraîchissement, aperçu automatique…).
export const GET: APIRoute = () => new Response('Utilisez le bouton « Générer le BL » de la fiche commande.', { status: 405, headers: { Allow: 'POST' } });
