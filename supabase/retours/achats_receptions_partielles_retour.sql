-- RETOUR ARRIÈRE de supabase/migrations/achats_receptions_partielles.sql — procédure A : RETRAIT COMPLET, UNIQUEMENT tant qu'aucune réception de commande n'a été enregistrée.
-- NON APPLIQUÉ en production. Ce fichier n'est PAS une migration : il vit hors de supabase/migrations pour ne jamais être rejoué par erreur.
--
-- GARDE-FOU : si la moindre réception rattachée à une commande, annulation archivée ou changement de quantité existe, ce script S'ARRÊTE (RETOUR_REFUSE) et ne
-- modifie rien : supprimer ces objets détruirait la trace de vraies entrées en stock. Dans ce cas, utiliser la procédure B (achats_receptions_partielles_desactivation.sql).
--
-- Ce qu'il retire (dans cet ordre) : les 3 fonctions d'écriture et les 2 fonctions de calcul ; les déclencheurs de protection et leurs fonctions ; les 2 tables d'historique ;
-- les colonnes ajoutées (stock_receptions : shipment_id, cle_idempotence, empreinte, bl_fournisseur, created_by, created_by_email, annulee_le, annulee_par, annulation_motif ;
-- stock_reception_items : shipment_item_id ; shipments : statut_avant_reception) avec leurs contraintes et index.
-- Ce qu'il ne fait PAS : aucune réception, ligne de réception, commande, ligne de commande, cumul, produit, stock, PUMP ni coût n'est modifié ; le journal admin_audit_logs
-- n'est jamais touché (les lignes « reception.commande », « reception.annulation », « commande.quantite » éventuelles y restent).
-- Rejouable sans effet une fois appliqué. Les données antérieures à la migration sont identiques avant/après (prouvé par test local).

BEGIN;

DO $$
BEGIN
  IF to_regclass('public.stock_receptions') IS NOT NULL
     AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'stock_receptions' AND column_name = 'shipment_id') THEN
    IF EXISTS (SELECT 1 FROM stock_receptions WHERE shipment_id IS NOT NULL OR cle_idempotence IS NOT NULL)
       OR EXISTS (SELECT 1 FROM stock_reception_items WHERE shipment_item_id IS NOT NULL)
       OR (to_regclass('public.stock_reception_items_annulees') IS NOT NULL AND EXISTS (SELECT 1 FROM stock_reception_items_annulees))
       OR (to_regclass('public.shipment_item_quantites_historique') IS NOT NULL AND EXISTS (SELECT 1 FROM shipment_item_quantites_historique)) THEN
      RAISE EXCEPTION 'RETOUR_REFUSE : des réceptions de commande, annulations ou changements de quantité ont été enregistrés. Ne rien supprimer : utiliser la procédure B (désactivation) ; les traces de stock doivent être conservées.';
    END IF;
  END IF;
END $$;

DROP FUNCTION IF EXISTS reception_commande_enregistrer(uuid, uuid, date, text, text, jsonb, uuid, text, text);
DROP FUNCTION IF EXISTS reception_commande_annuler(uuid, text, uuid, text, text);
DROP FUNCTION IF EXISTS shipment_item_quantite_modifier(uuid, integer, text, uuid, text, text);
DROP FUNCTION IF EXISTS shipment_reception_etat(uuid);
DROP FUNCTION IF EXISTS shipment_reception_quantites(uuid);

DROP TRIGGER IF EXISTS trg_shipment_items_proteger ON shipment_items;
DROP TRIGGER IF EXISTS trg_shipment_items_proteger_truncate ON shipment_items;
DROP TRIGGER IF EXISTS trg_shipments_proteger ON shipments;
DROP TRIGGER IF EXISTS trg_stock_receptions_proteger ON stock_receptions;
DROP TRIGGER IF EXISTS trg_stock_receptions_proteger_truncate ON stock_receptions;
DROP TRIGGER IF EXISTS trg_stock_reception_items_proteger ON stock_reception_items;
DROP TRIGGER IF EXISTS trg_stock_reception_items_proteger_truncate ON stock_reception_items;

DROP TABLE IF EXISTS shipment_item_quantites_historique;
DROP TABLE IF EXISTS stock_reception_items_annulees;

DROP FUNCTION IF EXISTS shipment_items_proteger();
DROP FUNCTION IF EXISTS shipments_proteger();
DROP FUNCTION IF EXISTS stock_receptions_proteger();
DROP FUNCTION IF EXISTS stock_reception_items_proteger();
DROP FUNCTION IF EXISTS achats_historique_proteger();

ALTER TABLE stock_reception_items DROP COLUMN IF EXISTS shipment_item_id;
ALTER TABLE shipments DROP COLUMN IF EXISTS statut_avant_reception;
ALTER TABLE stock_receptions
  DROP COLUMN IF EXISTS shipment_id, DROP COLUMN IF EXISTS cle_idempotence, DROP COLUMN IF EXISTS empreinte, DROP COLUMN IF EXISTS bl_fournisseur,
  DROP COLUMN IF EXISTS created_by, DROP COLUMN IF EXISTS created_by_email, DROP COLUMN IF EXISTS annulee_le, DROP COLUMN IF EXISTS annulee_par,
  DROP COLUMN IF EXISTS annulation_motif;

COMMIT;
