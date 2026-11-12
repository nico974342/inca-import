import { supabaseAdmin } from './supabase';
import { fetchGrantedForUser } from './catalogue';
import type { DepotCommande, CommandeRecente, LigneBrute } from './commandeActions';
import type { Disponibilite } from './panier';

/** Accès réels aux données du panier. La disponibilité vient de la vue product_availability : la MÊME définition que la fonction SQL de création de commande. */
export function depotCommande(user: { id: string; email?: string | null; app_metadata?: unknown; user_metadata?: unknown }): DepotCommande {
  return {
    async lireLignes(userId) {
      const { data, error } = await supabaseAdmin.from('cart_items').select('product_id, quantity, products(id, name, unit)').eq('user_id', userId).order('updated_at', { ascending: true });
      if (error) throw new Error(`panier illisible : ${error.message}`);
      return (data ?? []).map((r: any): LigneBrute => ({ product_id: r.product_id, quantity: r.quantity, nom: r.products?.name ?? 'Produit inconnu', unit: r.products?.unit ?? null }));
    },
    async lireDisponibilites(_userId, ids) {
      const out = new Map<string, Disponibilite>();
      if (ids.length === 0) return out;
      const [{ data: prods, error: e1 }, { data: dispo, error: e2 }] = await Promise.all([
        supabaseAdmin.from('products').select('id, visible_catalogue').in('id', ids),
        supabaseAdmin.from('product_availability').select('product_id, available').in('product_id', ids),
      ]);
      // Une lecture impossible ne doit JAMAIS passer pour « tout est disponible » : on remonte l'erreur.
      if (e1 || e2) throw new Error(`disponibilité illisible : ${(e1 ?? e2)!.message}`);
      const masquesAutorises = (prods ?? []).some((p: any) => p.visible_catalogue === false) ? await fetchGrantedForUser(user as any) : new Set<string>();
      const dispoParId = new Map((dispo ?? []).map((d: any) => [d.product_id, Number(d.available ?? 0)]));
      for (const p of prods ?? []) out.set((p as any).id, { available: dispoParId.get((p as any).id) ?? 0, commandable: (p as any).visible_catalogue !== false || masquesAutorises.has((p as any).id) });
      return out;
    },
    async ecrireQuantite(userId, productId, quantite) {
      const { error } = await supabaseAdmin.from('cart_items').upsert({ user_id: userId, product_id: productId, quantity: quantite, updated_at: new Date().toISOString() }, { onConflict: 'user_id,product_id' });
      if (error) throw new Error(`panier non modifié : ${error.message}`);
    },
    async retirer(userId, productId) {
      const { error } = await supabaseAdmin.from('cart_items').delete().eq('user_id', userId).eq('product_id', productId);
      if (error) throw new Error(`panier non modifié : ${error.message}`);
    },
    async viderPanier(userId) {
      const { error } = await supabaseAdmin.from('cart_items').delete().eq('user_id', userId);
      if (error) return false;
      const { count, error: e2 } = await supabaseAdmin.from('cart_items').select('product_id', { count: 'exact', head: true }).eq('user_id', userId);
      return !e2 && (count ?? 0) === 0;                                                                          // vidé SEULEMENT si on l'a constaté
    },
    async derniereCommande(userId): Promise<CommandeRecente | null> {
      const { data } = await supabaseAdmin.from('orders').select('id, created_at, order_items(product_id, quantity)').eq('user_id', userId).order('created_at', { ascending: false }).limit(1).maybeSingle();
      if (!data) return null;
      return { id: (data as any).id, secondes: Math.max(0, Math.round((Date.now() - new Date((data as any).created_at).getTime()) / 1000)), lignes: ((data as any).order_items ?? []).map((i: any) => ({ product_id: i.product_id, quantity: i.quantity })) };
    },
  };
}
