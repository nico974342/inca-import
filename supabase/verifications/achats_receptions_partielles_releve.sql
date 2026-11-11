-- RELEVÉ DE PRODUCTION (LECTURE SEULE) — à exécuter JUSTE AVANT puis JUSTE APRÈS l'application de achats_receptions_partielles.sql, et à conserver.
-- Aucune écriture, aucun appel de fonction qui écrit. Ce fichier n'est PAS une migration : il vit hors de supabase/migrations.
-- Lecture : les sections 1 à 6 doivent être STRICTEMENT IDENTIQUES avant et après. Seule la section 7 change (objets de la migration : absents puis présents).
-- Il n'existe pas de table de « mouvements de stock » : le stock physique est products.stock_quantity ; ses entrées sont stock_receptions + stock_reception_items ; les
-- sorties sont les commandes clients (réservé / disponible : vue product_availability) ; les ajustements manuels sont tracés dans admin_audit_logs (section 5).

-- ═══ 1. COMMANDES FOURNISSEURS ═══
SELECT s.id, s.reference, s.supplier_name, s.status AS statut_logistique, s.eta, count(i.id) AS lignes, coalesce(sum(i.quantity), 0) AS commande,
       coalesce(sum(i.received_quantity), 0) AS cumul_recu, count(*) FILTER (WHERE coalesce(i.received_quantity, 0) >= i.quantity) AS lignes_soldees
FROM shipments s LEFT JOIN shipment_items i ON i.shipment_id = s.id GROUP BY s.id, s.reference, s.supplier_name, s.status, s.eta, s.created_at ORDER BY s.created_at, s.id;

-- ═══ 2. LIGNES DE COMMANDE ET QUANTITÉS REÇUES (ligne par ligne) ═══
SELECT i.id, s.reference, i.product_id, i.quantity AS commande, i.received_quantity AS cumul_recu, i.unit_cost_ht, i.dlc FROM shipment_items i JOIN shipments s ON s.id = i.shipment_id ORDER BY s.created_at, i.id;

-- ═══ 3. RÉCEPTIONS ENREGISTRÉES (historiques : aucune n'est rattachée à une commande avant la migration) ═══
SELECT r.id, r.received_at, r.supplier_name, r.stock_applied, r.notes, count(i.id) AS lignes, coalesce(sum(i.quantity), 0) AS cartons, coalesce(sum(i.quantity * i.unit_cost_ht), 0) AS valeur_ht
FROM stock_receptions r LEFT JOIN stock_reception_items i ON i.reception_id = r.id GROUP BY r.id ORDER BY r.created_at, r.id;

-- ═══ 4. STOCKS (physique, réservé, disponible) ET PRIX D'ACHAT MOYEN, produit par produit ═══
SELECT p.id, p.name, p.stock_quantity AS physique, a.reserved AS reserve, a.available AS disponible, p.prix_achat_moyen_ht FROM products p LEFT JOIN product_availability a ON a.product_id = p.id ORDER BY p.id;

-- ═══ 5. HISTORIQUES : empreintes des lignes de réception, du journal, et actions liées aux achats et aux stocks ═══
SELECT 'lignes de réception' AS objet, count(*) AS lignes, coalesce(sum(quantity), 0) AS somme,
       md5(coalesce(string_agg(concat_ws('|', id, reception_id, product_id, quantity, unit_cost_ht, coalesce(dlc::text, ''), created_at), ',' ORDER BY id), '')) AS empreinte FROM stock_reception_items
UNION ALL
SELECT 'journal admin_audit_logs', count(*), 0, md5(coalesce(string_agg(id::text, ',' ORDER BY created_at, id), '')) FROM admin_audit_logs
UNION ALL
SELECT 'action ' || action, count(*), 0, to_char(max(created_at), 'YYYY-MM-DD HH24:MI') FROM admin_audit_logs WHERE action LIKE 'reception.%' OR action LIKE 'transit.%' OR action LIKE 'stock.%' OR action LIKE 'achats.%' GROUP BY action
ORDER BY 1;

-- ═══ 6. PERMISSIONS ET OBJETS EXISTANTS (copie exacte à conserver) ═══
SELECT t.table_name AS objet, r.role AS role, has_table_privilege(r.role, 'public.' || t.table_name, 'SELECT') AS select_, has_table_privilege(r.role, 'public.' || t.table_name, 'INSERT') AS insert_,
       has_table_privilege(r.role, 'public.' || t.table_name, 'UPDATE') AS update_, has_table_privilege(r.role, 'public.' || t.table_name, 'DELETE') AS delete_, c.relrowsecurity AS rls
FROM (VALUES ('shipments'), ('shipment_items'), ('stock_receptions'), ('stock_reception_items'), ('products'), ('admin_audit_logs')) AS t(table_name)
CROSS JOIN (VALUES ('anon'), ('authenticated'), ('service_role')) AS r(role)
JOIN pg_class c ON c.relnamespace = 'public'::regnamespace AND c.relname = t.table_name ORDER BY 1, 2;

SELECT p.oid::regprocedure::text AS fonction, md5(pg_get_functiondef(p.oid)) AS empreinte, has_function_privilege('anon', p.oid, 'EXECUTE') AS anon_,
       has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authenticated_, has_function_privilege('service_role', p.oid, 'EXECUTE') AS service_role_
FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname IN ('recalc_pump', 'reception_create', 'reception_update', 'reception_delete', 'product_adjust_stock') ORDER BY 1;

SELECT 'vue product_availability' AS objet, md5(definition) AS empreinte FROM pg_views WHERE schemaname = 'public' AND viewname = 'product_availability';

-- ═══ 7. OBJETS DE LA MIGRATION (avant : tout à 0 et aucun déclencheur ; après : 10 fonctions, 11 colonnes, 2 tables, 7 déclencheurs sur les 4 tables) ═══
SELECT tgrelid::regclass::text AS table_, tgname AS declencheur FROM pg_trigger WHERE NOT tgisinternal
  AND tgrelid::regclass::text IN ('shipments', 'shipment_items', 'stock_receptions', 'stock_reception_items') ORDER BY 1, 2;
SELECT (SELECT count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname IN ('reception_commande_enregistrer', 'reception_commande_annuler', 'shipment_item_quantite_modifier',
          'shipment_reception_etat', 'shipment_reception_quantites', 'shipment_items_proteger', 'shipments_proteger', 'stock_receptions_proteger', 'stock_reception_items_proteger', 'achats_historique_proteger')) AS fonctions,
       (SELECT count(*) FROM information_schema.columns WHERE table_schema = 'public' AND ((table_name = 'stock_receptions' AND column_name IN ('shipment_id', 'cle_idempotence', 'empreinte', 'bl_fournisseur',
          'created_by', 'created_by_email', 'annulee_le', 'annulee_par', 'annulation_motif')) OR (table_name = 'stock_reception_items' AND column_name = 'shipment_item_id')
          OR (table_name = 'shipments' AND column_name = 'statut_avant_reception'))) AS colonnes,
       (SELECT count(*) FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relname IN ('stock_reception_items_annulees', 'shipment_item_quantites_historique')) AS tables_;
