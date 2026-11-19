-- CONTRÔLE EN LECTURE SEULE (aucune écriture) : compare le moteur CUMP (tables cump_*) à la simulation indépendante (requête récursive), ligne par ligne, sur toute la base.
-- À lancer APRÈS le remplissage initial (cump_recalculer_tout), avec la production dans le même état (aucune livraison ni réception entre le remplissage et ce contrôle).
-- Résultat attendu : écarts = 0 sur toutes les lignes « mismatch_* » ; les totaux « simulation » et « moteur » sont identiques.
-- (Valeurs de la simulation du 2026-11-19 pour mémoire : 1 394 lignes livrées ; 1 345 recalculables et comparables ; marge actuelle 31 489,42 € → recalculée 32 648,05 € ; 7 lignes reconstituées ; 42 non recalculables.)
WITH RECURSIVE
trace AS (SELECT a.target_id, max(a.created_at) t FROM admin_audit_logs a WHERE a.action = 'commande.statut' AND a.details ->> 'nouveau' = 'livree' GROUP BY 1),
ev AS (SELECT *, row_number() OVER (PARTITION BY pid ORDER BY t, k, tie) n FROM (
  SELECT i.product_id pid, (r.received_at::timestamp AT TIME ZONE 'Indian/Reunion') t, 0 k, i.quantity qty, i.unit_cost_ht cost, NULL::uuid item_id, i.id tie
  FROM stock_reception_items i JOIN stock_receptions r ON r.id = i.reception_id WHERE (to_jsonb(r) ->> 'annulee_le') IS NULL
  UNION ALL
  SELECT oi.product_id, coalesce(tr.t, o.created_at), 1, oi.stock_decremented, NULL::numeric, oi.id, oi.id
  FROM order_items oi JOIN orders o ON o.id = oi.order_id LEFT JOIN trace tr ON tr.target_id = o.id::text WHERE oi.stock_decremented > 0 AND oi.product_id IS NOT NULL) x),
st(pid, n, q, avg, k, item_id, cout, couvert) AS (
  SELECT DISTINCT pid, 0::bigint, 0::numeric, NULL::numeric, NULL::int, NULL::uuid, NULL::numeric, NULL::boolean FROM ev
  UNION ALL
  SELECT e.pid, e.n, CASE WHEN e.k = 0 THEN s.q + e.qty ELSE greatest(0, s.q - e.qty) END,
    CASE WHEN e.k = 0 THEN CASE WHEN s.q <= 0 OR s.avg IS NULL THEN e.cost ELSE (s.q * s.avg + e.qty * e.cost) / (s.q + e.qty) END ELSE s.avg END,
    e.k, e.item_id, CASE WHEN e.k = 1 AND s.q >= e.qty THEN s.avg END, CASE WHEN e.k = 1 THEN s.q >= e.qty END
  FROM st s JOIN ev e ON e.pid = s.pid AND e.n = s.n + 1),
sim AS (SELECT item_id, cout, couvert FROM st WHERE k = 1)
SELECT k, v FROM (
  SELECT 1 o, 'lignes_simulation' k, count(*)::text v FROM sim
  UNION ALL SELECT 2, 'lignes_moteur', count(*)::text FROM cump_sorties
  UNION ALL SELECT 3, 'mismatch_lignes_absentes_du_moteur', count(*)::text FROM sim s WHERE NOT EXISTS (SELECT 1 FROM cump_sorties c WHERE c.order_item_id = s.item_id)
  UNION ALL SELECT 4, 'mismatch_couverture', count(*)::text FROM sim s JOIN cump_sorties c ON c.order_item_id = s.item_id WHERE c.couvert IS DISTINCT FROM s.couvert
  UNION ALL SELECT 5, 'mismatch_cout (écart > 1e-6, hors lignes volontairement non reconstituées)', count(*)::text FROM sim s JOIN cump_sorties c ON c.order_item_id = s.item_id
    WHERE s.couvert AND c.cout_cump IS NOT NULL AND abs(c.cout_cump - s.cout) > 0.000001
  UNION ALL SELECT 6, 'couvertes_sans_cout_moteur (attendu : seulement les lignes sans coût d''origine à reconstitution non fiable)', count(*)::text FROM sim s JOIN cump_sorties c ON c.order_item_id = s.item_id
    WHERE s.couvert AND c.cout_cump IS NULL AND c.motif = 'sans_cout_origine_reconstitution_non_fiable'
  UNION ALL SELECT 7, 'couvertes_sans_cout_moteur_inexpliquees', count(*)::text FROM sim s JOIN cump_sorties c ON c.order_item_id = s.item_id
    WHERE s.couvert AND c.cout_cump IS NULL AND c.motif IS DISTINCT FROM 'sans_cout_origine_reconstitution_non_fiable'
  UNION ALL SELECT 10, 'repartition_fiabilite', string_agg(fiabilite || '=' || n, ', ' ORDER BY fiabilite) FROM (SELECT fiabilite, count(*) n FROM cump_sorties GROUP BY 1) z
  UNION ALL SELECT 11, 'lignes_reconstituees', count(*)::text FROM cump_sorties WHERE reconstitue
  UNION ALL SELECT 12, 'lignes_date_approchee', count(*)::text FROM cump_sorties WHERE source_date = 'creation_commande_approchee'
  UNION ALL SELECT 20, 'marge_actuelle_lignes_recalculables_et_comparables', round(sum((oi.price_ht_snapshot - oi.pump_snapshot) * oi.quantity), 2)::text
    FROM cump_sorties c JOIN order_items oi ON oi.id = c.order_item_id WHERE c.cout_cump IS NOT NULL AND oi.pump_snapshot IS NOT NULL AND oi.price_ht_snapshot IS NOT NULL
  UNION ALL SELECT 21, 'marge_recalculee_memes_lignes', round(sum((oi.price_ht_snapshot - c.cout_cump) * oi.quantity), 2)::text
    FROM cump_sorties c JOIN order_items oi ON oi.id = c.order_item_id WHERE c.cout_cump IS NOT NULL AND oi.pump_snapshot IS NOT NULL AND oi.price_ht_snapshot IS NOT NULL
  UNION ALL SELECT 22, 'marge_recalculee_simulation_memes_lignes', round(sum((oi.price_ht_snapshot - s.cout) * oi.quantity), 2)::text
    FROM sim s JOIN order_items oi ON oi.id = s.item_id WHERE s.couvert AND oi.pump_snapshot IS NOT NULL AND oi.price_ht_snapshot IS NOT NULL
  UNION ALL SELECT 30, 'pump_snapshot_modifies (attendu : 0, comparer au relevé avant)', md5(coalesce(string_agg(id || ':' || coalesce(pump_snapshot::text, '-'), ',' ORDER BY id), '')) FROM order_items
) t ORDER BY o;
