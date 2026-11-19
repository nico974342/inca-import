-- CONTRÔLE EN LECTURE SEULE (aucune écriture) : compare le moteur CUMP (tables cump_*) à une implémentation indépendante (requête récursive), ligne par ligne, sur toute la base — MÉTHODE v2.
-- À lancer APRÈS un remplissage (cump_recalculer_tout), avec la production dans le même état (aucune livraison, réception ni ajustement entre le remplissage et ce contrôle).
-- Résultat attendu : toutes les lignes « mismatch_* » à 0 ; les marges « moteur » et « simulation » sont identiques.
-- Règles de la simulation v2 : réceptions appliquées à leur date (minuit, Réunion) ; réceptions historiques = stock d'ouverture disponible dès l'origine ; ventes à la date de livraison tracée (sinon date de
-- commande) ; ajustements manuels : hausse de provenance inconnue non valorisée, doublon d'une réception historique ignoré, baisse = annule d'abord les entrées inconnues puis sortie réelle au coût moyen.
WITH RECURSIVE
trace AS (SELECT a.target_id, max(a.created_at) t FROM admin_audit_logs a WHERE a.action = 'commande.statut' AND a.details ->> 'nouveau' = 'livree' GROUP BY 1),
ev AS (SELECT *, row_number() OVER (PARTITION BY pid ORDER BY t, k, tie) n FROM (
  SELECT i.product_id pid, 0 k, CASE WHEN r.stock_applied THEN (r.received_at::timestamp AT TIME ZONE 'Indian/Reunion') ELSE timestamptz '1970-01-01' END t, i.quantity qty, i.unit_cost_ht cost, NULL::uuid item_id, i.id tie, false dbl
  FROM stock_reception_items i JOIN stock_receptions r ON r.id = i.reception_id WHERE (to_jsonb(r) ->> 'annulee_le') IS NULL
  UNION ALL
  SELECT oi.product_id, 1, coalesce(tr.t, o.created_at), oi.stock_decremented, NULL::numeric, oi.id, oi.id, false
  FROM order_items oi JOIN orders o ON o.id = oi.order_id LEFT JOIN trace tr ON tr.target_id = o.id::text WHERE oi.stock_decremented > 0 AND oi.product_id IS NOT NULL
  UNION ALL
  SELECT p.id, 2, a.created_at, (a.details ->> 'apres')::int - (a.details ->> 'avant')::int, NULL::numeric, NULL::uuid, a.id,
         ((a.details ->> 'avant')::int = 0 AND (a.details ->> 'apres')::int > 0 AND EXISTS (SELECT 1 FROM stock_reception_items i2 JOIN stock_receptions r2 ON r2.id = i2.reception_id
            WHERE i2.product_id = p.id AND NOT r2.stock_applied AND i2.quantity = (a.details ->> 'apres')::int AND (to_jsonb(r2) ->> 'annulee_le') IS NULL))
  FROM admin_audit_logs a JOIN products p ON p.id::text = a.target_id
  WHERE a.action = 'produit.stock_ajustement' AND coalesce(a.details ->> 'avant', '') ~ '^-?[0-9]+$' AND coalesce(a.details ->> 'apres', '') ~ '^-?[0-9]+$') x),
st(pid, n, q, avg, u, k, item_id, cout, couvert) AS (
  SELECT DISTINCT pid, 0::bigint, 0::numeric, NULL::numeric, 0, NULL::int, NULL::uuid, NULL::numeric, NULL::boolean FROM ev
  UNION ALL
  SELECT e.pid, e.n,
    CASE WHEN e.k = 0 THEN s.q + e.qty WHEN e.k = 1 THEN greatest(0, s.q - e.qty) WHEN e.qty < 0 THEN greatest(0, s.q - greatest(0, -e.qty - s.u)) ELSE s.q END,
    CASE WHEN e.k = 0 THEN CASE WHEN s.q <= 0 OR s.avg IS NULL THEN e.cost ELSE (s.q * s.avg + e.qty * e.cost) / (s.q + e.qty) END ELSE s.avg END,
    CASE WHEN e.k = 2 THEN CASE WHEN e.qty > 0 AND NOT e.dbl THEN s.u + e.qty WHEN e.qty < 0 THEN s.u - least(s.u, -e.qty) ELSE s.u END ELSE s.u END,
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
  UNION ALL SELECT 6, 'couvertes_sans_cout_moteur (reconstitution non fiable, attendu)', count(*)::text FROM sim s JOIN cump_sorties c ON c.order_item_id = s.item_id
    WHERE s.couvert AND c.cout_cump IS NULL AND c.motif = 'sans_cout_origine_reconstitution_non_fiable'
  UNION ALL SELECT 7, 'couvertes_sans_cout_moteur_inexpliquees', count(*)::text FROM sim s JOIN cump_sorties c ON c.order_item_id = s.item_id
    WHERE s.couvert AND c.cout_cump IS NULL AND c.motif IS DISTINCT FROM 'sans_cout_origine_reconstitution_non_fiable'
  UNION ALL SELECT 8, 'lignes_non_calculees_en_version_1 (version_methode <> 2 : à recalculer)', count(*)::text FROM cump_sorties WHERE version_methode <> 2
  UNION ALL SELECT 10, 'repartition_fiabilite', string_agg(fiabilite || '=' || n, ', ' ORDER BY fiabilite) FROM (SELECT fiabilite, count(*) n FROM cump_sorties GROUP BY 1) z
  UNION ALL SELECT 11, 'lignes_reconstituees', count(*)::text FROM cump_sorties WHERE reconstitue
  UNION ALL SELECT 12, 'lignes_date_approchee', count(*)::text FROM cump_sorties WHERE source_date = 'creation_commande_approchee'
  UNION ALL SELECT 20, 'marge_actuelle_lignes_recalculables_et_comparables', round(sum((oi.price_ht_snapshot - oi.pump_snapshot) * oi.quantity), 2)::text
    FROM cump_sorties c JOIN order_items oi ON oi.id = c.order_item_id WHERE c.cout_cump IS NOT NULL AND oi.pump_snapshot IS NOT NULL AND oi.price_ht_snapshot IS NOT NULL
  UNION ALL SELECT 21, 'marge_recalculee_memes_lignes', round(sum((oi.price_ht_snapshot - c.cout_cump) * oi.quantity), 2)::text
    FROM cump_sorties c JOIN order_items oi ON oi.id = c.order_item_id WHERE c.cout_cump IS NOT NULL AND oi.pump_snapshot IS NOT NULL AND oi.price_ht_snapshot IS NOT NULL
  UNION ALL SELECT 22, 'marge_recalculee_simulation_memes_lignes', round(sum((oi.price_ht_snapshot - s.cout) * oi.quantity), 2)::text
    FROM sim s JOIN order_items oi ON oi.id = s.item_id JOIN cump_sorties c ON c.order_item_id = s.item_id WHERE s.couvert AND c.cout_cump IS NOT NULL AND oi.pump_snapshot IS NOT NULL AND oi.price_ht_snapshot IS NOT NULL
  UNION ALL SELECT 30, 'pump_snapshot_empreinte (comparer au relevé avant)', md5(coalesce(string_agg(id || ':' || coalesce(pump_snapshot::text, '-'), ',' ORDER BY id), '')) FROM order_items
) t ORDER BY o;
