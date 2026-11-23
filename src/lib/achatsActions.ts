import { type Achats } from './achatsReception';
import { type UtilisateurSession } from './portefeuille';

/**
 * Formulaires du Suivi des achats (réception d'une livraison, annulation, modification justifiée d'une quantité commandée). Le formulaire n'apporte que des
 * CHOIX ; l'identité et le rôle viennent de la session (bibliothèque `achatsReception`). Une erreur est TOUJOURS renvoyée à l'écran avec son explication : la
 * base n'écrit rien tant qu'une seule des opérations (réception, lignes, stock, cumuls, rattachement, état) échoue.
 */
export type Formulaire = { get(nom: string): unknown; getAll(nom: string): unknown[] };
export type ResultatAchats = { ok: boolean; message: string; deja?: boolean };
const champ = (f: Formulaire, nom: string) => { const v = f.get(nom); return typeof v === 'string' ? v : ''; };

/** Livraison reçue : une ligne par produit de la commande (quantité, coût, DLC), laissées à 0 si non livrées. */
export async function traiterReception(a: Pick<Achats, 'enregistrer'>, utilisateur: UtilisateurSession, shipmentId: string, f: Formulaire): Promise<ResultatAchats> {
  const ids = f.getAll('ligne_id[]'); const q = f.getAll('quantity[]'); const c = f.getAll('unit_cost_ht[]'); const d = f.getAll('dlc[]');
  if (ids.length !== q.length || ids.length !== c.length || ids.length !== d.length) return { ok: false, message: 'Formulaire incomplet : rechargez la page.' };
  const r = await a.enregistrer({
    utilisateur, cle: champ(f, 'cle'), shipmentId, receivedAt: champ(f, 'received_at'), bl: champ(f, 'bl_fournisseur'), notes: champ(f, 'notes'),
    lignes: ids.map((id, i) => ({ id, quantite: q[i], cout: c[i], dlc: d[i] })),
  });
  if (!r.ok) return { ok: false, message: r.message };
  const deja = !!(r.data as { deja?: boolean } | null)?.deja;
  return { ok: true, deja, message: deja ? 'Cette réception était déjà enregistrée (double envoi ignoré) : le stock n\'a été augmenté qu\'une seule fois.' : 'Réception enregistrée : stock et cumuls mis à jour.' };
}

/** Corrections réservées à l'administrateur : annulation d'une réception, modification justifiée d'une quantité commandée. */
export async function traiterCorrection(a: Pick<Achats, 'annuler' | 'modifierQuantite'>, utilisateur: UtilisateurSession, f: Formulaire): Promise<ResultatAchats> {
  const operation = champ(f, 'operation');
  if (operation === 'annuler') {
    if (champ(f, 'confirme') !== 'oui') return { ok: false, message: 'Confirmez l\'annulation (case à cocher) : rien n\'a été modifié.' };
    const r = await a.annuler({ utilisateur, receptionId: champ(f, 'reception_id'), motif: champ(f, 'motif') });
    return r.ok ? { ok: true, message: 'Réception annulée : stock et cumuls régularisés. L\'opération d\'origine reste visible dans l\'historique (journalisée).' } : { ok: false, message: r.message };
  }
  if (operation === 'quantite') {
    const r = await a.modifierQuantite({ utilisateur, ligneId: champ(f, 'ligne_id'), quantite: champ(f, 'quantite'), motif: champ(f, 'motif') });
    return r.ok ? { ok: true, message: 'Quantité commandée modifiée (motif et historique enregistrés).' } : { ok: false, message: r.message };
  }
  return { ok: false, message: 'Opération inconnue.' };
}
