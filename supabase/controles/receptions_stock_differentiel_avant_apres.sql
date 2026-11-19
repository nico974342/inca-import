-- CONTRÔLE AVANT / APRÈS de receptions_stock_differentiel.sql — LECTURE SEULE (aucune écriture). À lancer deux fois et à comparer ligne à ligne :
--   • AVANT la migration, puis APRÈS (et de nouveau après le déploiement du code).
--   • Toutes les lignes « donnees.* » doivent être IDENTIQUES : la migration ne touche aucune donnée (stocks, réservations, commandes, lignes, réceptions, coûts).
--     (Seule une vraie opération faite entre les deux relevés — commande, livraison, réception — peut les changer : relever alors les deux à quelques secondes d'écart.)
--   • Lignes « fonction.* » : AVANT, reception_update / reception_delete ont leur ancienne empreinte et les deux fonctions internes sont absentes ;
--     APRÈS, les deux premières ont une NOUVELLE empreinte, les deux internes existent, et TOUTES ont les mêmes droits (service_role seul), search_path fixé, pas SECURITY DEFINER.
--     Les autres fonctions (reception_create, recalc_pump, order_*, stock_reserving_statuses) gardent EXACTEMENT leur empreinte.
SELECT k, v FROM (
  SELECT 1 AS o, 'donnees.produits' AS k, count(*)::text AS v FROM products
  UNION ALL SELECT 2, 'donnees.stock_total', coalesce(sum(stock_quantity), 0)::text FROM products
  UNION ALL SELECT 3, 'donnees.stock_md5', md5(coalesce(string_agg(id || ':' || stock_quantity || ':' || in_stock, ',' ORDER BY id), '')) FROM products
  UNION ALL SELECT 4, 'donnees.pump_md5', md5(coalesce(string_agg(id || ':' || coalesce(prix_achat_moyen_ht::text, '-'), ',' ORDER BY id), '')) FROM products
  UNION ALL SELECT 5, 'donnees.reserve_total', coalesce(sum(oi.quantity), 0)::text FROM order_items oi JOIN orders o ON o.id = oi.order_id WHERE o.status = ANY (stock_reserving_statuses())
  UNION ALL SELECT 6, 'donnees.produits_disponible_negatif', count(*)::text FROM product_availability WHERE available < 0
  UNION ALL SELECT 7, 'donnees.commandes', count(*) || ' / ' || md5(coalesce(string_agg(id || ':' || status, ',' ORDER BY id), '')) FROM orders
  UNION ALL SELECT 8, 'donnees.lignes_commande', count(*) || ' / ' || md5(coalesce(string_agg(id || ':' || quantity || ':' || coalesce(stock_decremented::text, '-') || ':' || coalesce(pump_snapshot::text, '-'), ',' ORDER BY id), '')) FROM order_items
  UNION ALL SELECT 9, 'donnees.receptions', count(*) || ' / ' || md5(coalesce(string_agg(id || ':' || stock_applied || ':' || received_at, ',' ORDER BY id), '')) FROM stock_receptions
  UNION ALL SELECT 10, 'donnees.lignes_reception', count(*) || ' / ' || md5(coalesce(string_agg(id || ':' || product_id || ':' || quantity || ':' || unit_cost_ht, ',' ORDER BY id), '')) FROM stock_reception_items
  UNION ALL SELECT 11, 'donnees.audit_logs', count(*)::text FROM admin_audit_logs
  UNION ALL
  SELECT 20, 'fonction.' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')',
         md5(pg_get_functiondef(p.oid)) || ' | droits=' || coalesce(p.proacl::text, 'défaut(PUBLIC!)') || ' | definer=' || p.prosecdef || ' | config=' || coalesce(p.proconfig::text, 'aucun')
  FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace
    AND p.proname IN ('reception_create', 'reception_update', 'reception_delete', 'reception_ecarts_stock', 'reception_verifier_ecarts', 'recalc_pump',
                      'stock_reserving_statuses', 'order_create_checked', 'order_create_idempotent', 'order_mark_livree', 'order_cancel_livree', 'product_adjust_stock')
) t ORDER BY o, k;
