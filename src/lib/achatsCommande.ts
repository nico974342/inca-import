import { supabaseAdmin } from './supabase';
import { computeLandedCosts, type ShipmentCostItem, type ShipmentCostLine } from './constants';
import { etatReception, type EtatReception } from './achatsReception';

/**
 * Lecture d'une commande fournisseur (expédition) pour les écrans de réception : lignes (commandé / reçu / reste), réceptions successives avec leurs
 * lignes, réceptions annulées (archivées, jamais supprimées), historique des changements de quantité commandée. Lecture seule : aucune écriture ici.
 * Quantités en CARTONS partout (commande, réception, stock).
 */
export type LigneCommande = {
  id: string; product_id: string; nom: string; sku: string | null; quantity: number; received_quantity: number | null;
  recu: number; reste: number; unit_cost_ht: number | null; cout_rendu: number | null; dlc: string | null;
};
export type LigneReception = { shipment_item_id: string | null; produit: string; quantity: number; unit_cost_ht: number };
export type ReceptionCommande = {
  id: string; received_at: string; created_at: string; notes: string | null; bl_fournisseur: string | null; created_by_email: string | null;
  annulee_le: string | null; annulee_par: string | null; annulation_motif: string | null; lignes: LigneReception[]; total: number;
};
export type ChangementQuantite = { ancienne: number; nouvelle: number; motif: string; par_email: string; created_at: string; produit: string };
export type CommandeDetail = {
  id: string; supplier_name: string; reference: string | null; status: string; eta: string | null; departure_date: string | null; notes: string | null;
  lignes: LigneCommande[]; etat: EtatReception; receptions: ReceptionCommande[]; changements: ChangementQuantite[];
  /** Cartons comptés dans le cumul sans réception détaillée (anciennes réceptions partielles, avant le suivi réception par réception). */
  avantSuivi: number; coutsEstimes: boolean;
};

export async function chargerCommande(id: string): Promise<CommandeDetail | null> {
  const { data: s, error } = await supabaseAdmin.from('shipments')
    .select('id, supplier_name, reference, status, eta, departure_date, notes, shipment_items(id, product_id, quantity, received_quantity, unit_cost_ht, dlc, products(name, sku)), shipment_costs(product_id, amount_ht, is_estimated)')
    .eq('id', id).maybeSingle();
  if (error || !s) return null;
  const brut = ((s as any).shipment_items ?? []) as any[];
  const costLines: ShipmentCostLine[] = ((s as any).shipment_costs ?? []).map((c: any) => ({ product_id: c.product_id, amount_ht: Number(c.amount_ht), is_estimated: c.is_estimated }));
  const items: ShipmentCostItem[] = brut.map(it => ({ product_id: it.product_id, quantity: it.quantity, unit_cost_ht: it.unit_cost_ht != null ? Number(it.unit_cost_ht) : null }));
  const landed = computeLandedCosts(items, costLines);
  const rendu = new Map(landed.items.map(it => [it.product_id, it.landedUnitCost]));
  const lignes: LigneCommande[] = brut.map(it => {
    const recu = it.received_quantity ?? 0;
    return {
      id: it.id, product_id: it.product_id, nom: it.products?.name ?? 'Produit supprimé', sku: it.products?.sku ?? null, quantity: it.quantity, received_quantity: it.received_quantity,
      recu, reste: Math.max(it.quantity - recu, 0), unit_cost_ht: it.unit_cost_ht != null ? Number(it.unit_cost_ht) : null,
      // coût rendu (prix fournisseur + frais d'import répartis) : proposé pour chaque livraison ; ajustable à la saisie, jamais écrit ailleurs
      cout_rendu: rendu.get(it.product_id) ?? (it.unit_cost_ht != null ? Number(it.unit_cost_ht) : null), dlc: it.dlc ?? null,
    };
  }).sort((a, b) => a.nom.localeCompare(b.nom, 'fr'));

  const { data: recs } = await supabaseAdmin.from('stock_receptions')
    .select('id, received_at, created_at, notes, bl_fournisseur, created_by_email, annulee_le, annulee_par, annulation_motif, stock_reception_items(shipment_item_id, quantity, unit_cost_ht, products(name)), stock_reception_items_annulees(shipment_item_id, quantity, unit_cost_ht, products(name))')
    .eq('shipment_id', id).order('created_at', { ascending: false });
  const receptions: ReceptionCommande[] = ((recs ?? []) as any[]).map(r => {
    const source = (r.annulee_le ? r.stock_reception_items_annulees : r.stock_reception_items) ?? [];
    const l = source.map((x: any) => ({ shipment_item_id: x.shipment_item_id, produit: x.products?.name ?? 'Produit supprimé', quantity: x.quantity, unit_cost_ht: Number(x.unit_cost_ht) }));
    return { id: r.id, received_at: r.received_at, created_at: r.created_at, notes: r.notes, bl_fournisseur: r.bl_fournisseur, created_by_email: r.created_by_email,
      annulee_le: r.annulee_le, annulee_par: r.annulee_par, annulation_motif: r.annulation_motif, lignes: l, total: l.reduce((n: number, x: LigneReception) => n + x.quantity, 0) };
  });
  const { data: hist } = await supabaseAdmin.from('shipment_item_quantites_historique')
    .select('ancienne, nouvelle, motif, par_email, created_at, products(name)').eq('shipment_id', id).order('created_at', { ascending: false });
  const changements: ChangementQuantite[] = ((hist ?? []) as any[]).map(h => ({ ancienne: h.ancienne, nouvelle: h.nouvelle, motif: h.motif, par_email: h.par_email, created_at: h.created_at, produit: h.products?.name ?? 'Produit supprimé' }));

  const detaille = receptions.filter(r => !r.annulee_le).reduce((n, r) => n + r.total, 0);
  const cumul = lignes.reduce((n, l) => n + l.recu, 0);
  return {
    id: (s as any).id, supplier_name: (s as any).supplier_name, reference: (s as any).reference, status: (s as any).status, eta: (s as any).eta,
    departure_date: (s as any).departure_date, notes: (s as any).notes, lignes, etat: etatReception(lignes, (s as any).status), receptions, changements,
    avantSuivi: Math.max(cumul - detaille, 0), coutsEstimes: landed.costsStatus === 'estime',
  };
}
