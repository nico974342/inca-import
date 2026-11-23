-- CONTRÔLE « AUCUNE OPÉRATION DE RÉCEPTION EN COURS » (LECTURE SEULE) — à exécuter après le gel des réceptions et juste AVANT la migration. Aucune écriture.
-- Ce fichier n'est PAS une migration. Condition d'arrêt : toute ligne renvoyée par les sections 1 à 4, ou un « gel_actif » à false en section 5 → NE PAS appliquer la migration ; attendre et relancer.

-- ═══ 1. REQUÊTES EN COURS touchant aux réceptions, aux commandes ou au stock (attendu : aucune ligne) ═══
SELECT pid, state, now() - xact_start AS duree_transaction, left(regexp_replace(query, '\s+', ' ', 'g'), 120) AS requete
FROM pg_stat_activity
WHERE datname = current_database() AND pid <> pg_backend_pid() AND state <> 'idle'
  AND query ~* '(stock_receptions|stock_reception_items|shipment_items|shipments|reception_create|reception_update|reception_delete|recalc_pump|product_adjust_stock)';

-- ═══ 2. TRANSACTIONS RESTÉES OUVERTES (attendu : aucune ligne) ═══
SELECT pid, state, now() - xact_start AS duree_transaction, left(regexp_replace(query, '\s+', ' ', 'g'), 120) AS derniere_requete
FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid() AND state IN ('idle in transaction', 'idle in transaction (aborted)');

-- ═══ 3. VERROUS D'ÉCRITURE sur les quatre tables (attendu : aucune ligne) ═══
SELECT c.relname AS table_, l.mode, l.granted, l.pid
FROM pg_locks l JOIN pg_class c ON c.oid = l.relation
WHERE c.relnamespace = 'public'::regnamespace AND c.relname IN ('shipments', 'shipment_items', 'stock_receptions', 'stock_reception_items') AND l.pid <> pg_backend_pid()
  AND l.mode IN ('RowExclusiveLock', 'ShareUpdateExclusiveLock', 'ShareLock', 'ShareRowExclusiveLock', 'ExclusiveLock', 'AccessExclusiveLock');

-- ═══ 4. ÉCRITURES RÉCENTES : réceptions, commandes et journal des 15 dernières minutes (attendu : 0, 0, 0) ═══
SELECT (SELECT count(*) FROM stock_receptions WHERE created_at > now() - interval '15 minutes') AS receptions_15min,
       (SELECT count(*) FROM shipments WHERE created_at > now() - interval '15 minutes') AS commandes_15min,
       (SELECT count(*) FROM admin_audit_logs WHERE created_at > now() - interval '15 minutes' AND (action LIKE 'reception.%' OR action LIKE 'transit.%' OR action LIKE 'stock.%' OR action LIKE 'achats.%')) AS journal_achats_15min;

-- ═══ 5. LE GEL EST ACTIF (attendu : gel_actif = true) ═══
SELECT NOT has_function_privilege('service_role', 'reception_create(text, date, text, boolean, jsonb, uuid)', 'EXECUTE')
   AND NOT has_function_privilege('service_role', 'reception_update(uuid, text, date, text, boolean, jsonb, uuid)', 'EXECUTE')
   AND NOT has_function_privilege('service_role', 'reception_delete(uuid)', 'EXECUTE') AS gel_actif;
