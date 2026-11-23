-- RELEVÉ « MARGES HISTORIQUES » (LECTURE SEULE) — preuve qu'aucune marge d'origine ne change pendant le déploiement des réceptions partielles.
-- Ce fichier n'est PAS une migration (aucune écriture). À exécuter AVANT l'étape 1 puis APRÈS chaque étape ; remplacer la limite par l'HEURE DE RÉFÉRENCE du relevé « avant » (UTC) :
-- la production est vivante (commandes, livraisons) : on ne compare QUE ce qui existait à cette heure et qui est immuable.
-- Attendu : h1, h2, h3, h4, h5 IDENTIQUES à la référence à toute étape. h6 (PUMP actuel) ne change qu'à une vraie réception de commande (et seulement pour les produits reçus).
-- Les coûts recalculés (cump_sorties.cout_cump) ne sont volontairement PAS comparés : ils évoluent légitimement quand une réception DATÉE AVANT des ventes déjà livrées est saisie ;
-- le coût d'origine (cout_initial, pump_snapshot) est immuable (déclencheur COUT_INITIAL_IMMUABLE) et c'est lui que h1 et h2 protègent.
WITH t AS (SELECT '2026-11-23 06:32:33+00'::timestamptz AS limite)   -- ← à remplacer par l'heure de référence du relevé « avant »
SELECT jsonb_build_object(
 'limite_utc', (SELECT limite FROM t),
 'h1_lignes_commande_figees', (SELECT jsonb_build_object('n', count(*), 'md5', md5(string_agg(concat_ws('|', oi.id, oi.order_id, oi.product_id, oi.quantity, oi.price_ht_snapshot, oi.pump_snapshot), E'\n' ORDER BY oi.id))) FROM order_items oi, t WHERE oi.created_at <= t.limite),
 'h2_cout_initial_figes', (SELECT jsonb_build_object('n', count(*), 'md5', md5(string_agg(concat_ws('|', s.order_item_id, coalesce(s.cout_initial::text,'-')), E'\n' ORDER BY s.order_item_id))) FROM cump_sorties s, t WHERE s.cree_le <= t.limite),
 'h3_historique_recalculs', (SELECT jsonb_build_object('n', count(*), 'md5', md5(string_agg(r::text, E'\n' ORDER BY r::text))) FROM (SELECT * FROM cump_recalculs, t WHERE cump_recalculs.cree_le <= t.limite) r),
 'h4_receptions_existantes', (SELECT jsonb_build_object('n', count(*), 'md5', md5(string_agg(concat_ws('|', ri.id, ri.reception_id, ri.product_id, ri.quantity, ri.unit_cost_ht), E'\n' ORDER BY ri.id))) FROM stock_reception_items ri, t WHERE ri.created_at <= t.limite),
 'h5_receptions_entetes', (SELECT jsonb_build_object('n', count(*), 'md5', md5(string_agg(concat_ws('|', r.id, r.received_at, r.supplier_name, r.stock_applied, r.created_at, coalesce(r.notes,'')), E'\n' ORDER BY r.id))) FROM stock_receptions r, t WHERE r.created_at <= t.limite),
 'h6_pump_produits_actuels', (SELECT md5(string_agg(concat_ws('|', id, coalesce(prix_achat_moyen_ht::text,'-')), E'\n' ORDER BY id)) FROM products)
) AS reference_figee;
