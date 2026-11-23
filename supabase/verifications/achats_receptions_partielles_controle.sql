-- CONTRÔLES (LECTURE SEULE) de la migration achats_receptions_partielles.sql — à exécuter AVANT et APRÈS ; aucune écriture, aucune fonction appelée qui écrit.
-- Ce fichier n'est PAS une migration : il vit hors de supabase/migrations.

-- ═══ 1. EMPREINTES DE L'EXISTANT (AVANT puis APRÈS : les deux résultats doivent être IDENTIQUES, ligne par ligne) ═══
-- Seules les colonnes qui existaient avant la migration sont lues. Une ligne par table : nombre de lignes + somme + empreinte MD5 de tout le contenu trié.
SELECT 'products' AS objet, count(*) AS lignes, coalesce(sum(stock_quantity), 0) AS somme,
       md5(coalesce(string_agg(concat_ws('|', id, stock_quantity, coalesce(prix_achat_moyen_ht::text, '')), ',' ORDER BY id), '')) AS empreinte FROM products
UNION ALL
SELECT 'shipments', count(*), 0, md5(coalesce(string_agg(concat_ws('|', id, supplier_name, coalesce(reference, ''), status, coalesce(eta::text, ''), coalesce(notes, '')), ',' ORDER BY id), '')) FROM shipments
UNION ALL
SELECT 'shipment_items', count(*), coalesce(sum(received_quantity), 0),
       md5(coalesce(string_agg(concat_ws('|', id, shipment_id, product_id, quantity, coalesce(unit_cost_ht::text, ''), coalesce(received_quantity::text, ''), coalesce(dlc::text, '')), ',' ORDER BY id), '')) FROM shipment_items
UNION ALL
SELECT 'stock_receptions', count(*), count(*) FILTER (WHERE stock_applied),
       md5(coalesce(string_agg(concat_ws('|', id, supplier_name, received_at, coalesce(notes, ''), stock_applied, created_at), ',' ORDER BY id), '')) FROM stock_receptions
UNION ALL
SELECT 'stock_reception_items', count(*), coalesce(sum(quantity), 0),
       md5(coalesce(string_agg(concat_ws('|', id, reception_id, product_id, quantity, unit_cost_ht, coalesce(dlc::text, ''), created_at), ',' ORDER BY id), '')) FROM stock_reception_items
UNION ALL
SELECT 'admin_audit_logs', count(*), 0, '' FROM admin_audit_logs
ORDER BY 1;

-- ═══ 2. APRÈS SEULEMENT : tout doit valoir true ═══
SELECT
  (SELECT count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname IN ('reception_commande_enregistrer', 'reception_commande_annuler', 'shipment_item_quantite_modifier',
     'shipment_reception_etat', 'shipment_reception_quantites', 'shipment_items_proteger', 'shipments_proteger', 'stock_receptions_proteger', 'stock_reception_items_proteger', 'achats_historique_proteger')) = 10 AS dix_fonctions,
  (SELECT count(*) FROM information_schema.columns WHERE table_schema = 'public' AND ((table_name = 'stock_receptions' AND column_name IN ('shipment_id', 'cle_idempotence', 'empreinte', 'bl_fournisseur',
     'created_by', 'created_by_email', 'annulee_le', 'annulee_par', 'annulation_motif')) OR (table_name = 'stock_reception_items' AND column_name = 'shipment_item_id')
     OR (table_name = 'shipments' AND column_name = 'statut_avant_reception'))) = 11 AS onze_colonnes,
  (SELECT count(*) FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relname IN ('stock_reception_items_annulees', 'shipment_item_quantites_historique') AND relrowsecurity) = 2 AS deux_tables_fermees,
  (SELECT count(*) FROM pg_trigger WHERE NOT tgisinternal AND tgname LIKE 'trg\_%proteger%' AND tgrelid::regclass::text IN ('shipment_items', 'shipments', 'stock_receptions', 'stock_reception_items',
     'stock_reception_items_annulees', 'shipment_item_quantites_historique')) = 11 AS onze_declencheurs,
  NOT EXISTS (SELECT 1 FROM stock_receptions WHERE shipment_id IS NOT NULL OR cle_idempotence IS NOT NULL OR annulee_le IS NOT NULL) AS aucune_reception_rattachee,
  NOT EXISTS (SELECT 1 FROM stock_reception_items WHERE shipment_item_id IS NOT NULL) AS aucune_ligne_rattachee,
  NOT has_function_privilege('anon', 'reception_commande_enregistrer(uuid, uuid, date, text, text, jsonb, uuid, text, text)', 'EXECUTE')
    AND NOT has_function_privilege('authenticated', 'reception_commande_annuler(uuid, text, uuid, text, text)', 'EXECUTE')
    AND NOT has_function_privilege('anon', 'shipment_item_quantite_modifier(uuid, integer, text, uuid, text, text)', 'EXECUTE') AS fonctions_fermees_au_public,
  has_function_privilege('service_role', 'reception_commande_enregistrer(uuid, uuid, date, text, text, jsonb, uuid, text, text)', 'EXECUTE')
    AND has_function_privilege('service_role', 'reception_commande_annuler(uuid, text, uuid, text, text)', 'EXECUTE')
    AND has_function_privilege('service_role', 'shipment_item_quantite_modifier(uuid, integer, text, uuid, text, text)', 'EXECUTE') AS fonctions_ouvertes_au_serveur,
  NOT has_table_privilege('service_role', 'stock_reception_items_annulees', 'DELETE') AND NOT has_table_privilege('service_role', 'shipment_item_quantites_historique', 'DELETE') AS historiques_sans_suppression;

-- ═══ 3. APRÈS SEULEMENT : état de réception de chaque commande existante (attendu : la commande « réceptionnée » reste « integrale » ; aucune n'est rouverte) ═══
SELECT id, reference, status AS statut_logistique, shipment_reception_etat(id)->>'statut' AS statut_reception, shipment_reception_etat(id)->>'commande' AS commande,
       shipment_reception_etat(id)->>'recu' AS recu, shipment_reception_etat(id)->>'reste' AS reste FROM shipments ORDER BY created_at;
