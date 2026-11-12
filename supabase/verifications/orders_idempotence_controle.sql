-- CONTRÔLES (LECTURE SEULE) de la migration orders_idempotence_cle.sql — à exécuter AVANT et APRÈS. Aucune écriture, aucune fonction appelée.
-- Ce fichier n'est PAS une migration : il vit hors de supabase/migrations.

-- ═══ 1. EMPREINTES DE L'EXISTANT (AVANT puis APRÈS : résultats IDENTIQUES, ligne par ligne) ═══
-- Seules les colonnes qui existaient avant la migration sont lues. Les empreintes des lignes de commande, du disponible (réservations) et des fonctions existantes aussi.
SELECT 'orders' AS objet, count(*) AS lignes, 0 AS somme,
       md5(coalesce(string_agg(concat_ws('|', id, coalesce(user_id::text, ''), coalesce(nom, ''), coalesce(email, ''), coalesce(status, ''), coalesce(notes, ''), created_at, coalesce(bl_number, ''), coalesce(client_id::text, ''), attribution, rattachement_groupe), ',' ORDER BY id), '')) AS empreinte FROM orders
UNION ALL
SELECT 'order_items', count(*), coalesce(sum(quantity), 0),
       md5(coalesce(string_agg(concat_ws('|', id, order_id, coalesce(product_id::text, ''), quantity, coalesce(price_ht_snapshot::text, ''), coalesce(tva_rate_snapshot::text, ''), coalesce(pump_snapshot::text, '')), ',' ORDER BY id), '')) FROM order_items
UNION ALL
SELECT 'product_availability (physique, réservé)', count(*), coalesce(sum(reserved), 0), md5(coalesce(string_agg(concat_ws('|', product_id, physical, reserved), ',' ORDER BY product_id), '')) FROM product_availability
UNION ALL
SELECT 'fonctions de commande existantes', count(*), 0, md5(coalesce(string_agg(p.oid::regprocedure::text || ':' || md5(pg_get_functiondef(p.oid)), ',' ORDER BY p.oid::regprocedure::text), ''))
  FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname IN ('order_create_checked', 'order_update_checked', 'order_cancel_livree', 'order_mark_livree', 'stock_reserving_statuses')
UNION ALL
SELECT 'droits de la table orders', 3, 0, md5(concat_ws('|', has_table_privilege('anon', 'public.orders', 'SELECT'), has_table_privilege('authenticated', 'public.orders', 'SELECT'), has_table_privilege('anon', 'public.orders', 'INSERT'),
       has_table_privilege('authenticated', 'public.orders', 'INSERT'), has_table_privilege('service_role', 'public.orders', 'SELECT'), has_table_privilege('service_role', 'public.orders', 'INSERT'), (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.orders'::regclass)))
UNION ALL
SELECT 'déclencheurs de orders', count(*), 0, md5(coalesce(string_agg(tgname, ',' ORDER BY tgname), '')) FROM pg_trigger WHERE tgrelid = 'public.orders'::regclass AND NOT tgisinternal
ORDER BY 1;

-- ═══ 2. APRÈS SEULEMENT : tout doit valoir true ═══
SELECT
  (SELECT count(*) FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'orders' AND column_name IN ('cle_commande', 'cle_empreinte')) = 2 AS deux_colonnes,
  EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'orders_cle_commande_idx') AS index_unique,
  EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'orders_cle_coherente') AS contrainte_coherence,
  (SELECT count(*) FROM orders WHERE cle_commande IS NOT NULL OR cle_empreinte IS NOT NULL) = 0 AS aucune_commande_existante_modifiee,
  EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'order_create_idempotent' AND pronamespace = 'public'::regnamespace AND NOT prosecdef AND proconfig::text LIKE '%search_path=public, pg_temp%') AS fonction_invoker_chemin_fige,
  has_function_privilege('service_role', 'order_create_idempotent(uuid, jsonb, jsonb)', 'EXECUTE') AS ouverte_au_serveur,
  NOT has_function_privilege('anon', 'order_create_idempotent(uuid, jsonb, jsonb)', 'EXECUTE') AND NOT has_function_privilege('authenticated', 'order_create_idempotent(uuid, jsonb, jsonb)', 'EXECUTE') AS fermee_au_public,
  NOT EXISTS (SELECT 1 FROM pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a WHERE p.proname = 'order_create_idempotent' AND p.pronamespace = 'public'::regnamespace AND a.grantee = 0 AND a.privilege_type = 'EXECUTE') AS pas_de_droit_public,
  NOT EXISTS (SELECT 1 FROM pg_roles r, pg_proc p WHERE p.proname = 'order_create_idempotent' AND p.pronamespace = 'public'::regnamespace AND NOT r.rolsuper AND r.oid <> p.proowner AND r.rolname <> 'service_role' AND has_function_privilege(r.oid, p.oid, 'EXECUTE')) AS aucun_autre_role;
