-- CONTRÔLE EN LECTURE SEULE (aucune écriture) : produits dont le stock physique affiché dépasse ce que l'historique permet d'expliquer,
-- parmi ceux qui ont une réception APPLIQUÉE modifiée au moins une fois (journal d'audit « reception.modification »).
--
--   théorique = quantités reçues (réceptions appliquées) − quantités sorties à la livraison (order_items.stock_decremented, commandes non annulées)
--               + ajustements manuels enregistrés au journal (produit.stock_ajustement : après − avant)
--   écart     = stock affiché − théorique
--
-- LIMITES : le stock d'ouverture saisi avant le journal, les réceptions « historiques » (sans effet sur le stock) et les anciennes réceptions supprimées
-- ne sont pas reconstituables ; un écart positif est donc un INDICE, à confirmer par un inventaire physique avant toute régularisation.
-- Un écart nul est, lui, rassurant. Aucun correctif n'est appliqué par cette requête.
WITH mods AS (
  SELECT a.target_id::uuid AS rid, count(*) AS nb, max(a.created_at)::date AS derniere
  FROM admin_audit_logs a WHERE a.action = 'reception.modification' AND a.target_id ~ '^[0-9a-f-]{36}$' GROUP BY 1
), lignes AS (
  SELECT i.product_id, r.supplier_name, r.received_at, i.quantity, m.nb, m.derniere
  FROM mods m JOIN stock_receptions r ON r.id = m.rid JOIN stock_reception_items i ON i.reception_id = r.id WHERE r.stock_applied
), rec AS (
  SELECT i.product_id, sum(i.quantity) q FROM stock_reception_items i JOIN stock_receptions r ON r.id = i.reception_id WHERE r.stock_applied GROUP BY 1
), ven AS (
  SELECT oi.product_id, sum(oi.stock_decremented) d FROM order_items oi JOIN orders o ON o.id = oi.order_id WHERE o.status <> 'annulee' GROUP BY 1
), adj AS (
  SELECT p.id AS product_id, sum((a.details->>'apres')::int - (a.details->>'avant')::int) s
  FROM admin_audit_logs a JOIN products p ON p.name = a.target_label WHERE a.action = 'produit.stock_ajustement' GROUP BY 1
)
SELECT p.name AS produit,
       string_agg(DISTINCT l.supplier_name || ' ' || l.received_at || ' x' || l.quantity || ' (' || l.nb || ' modif., dernière ' || l.derniere || ')', ' | ') AS receptions_modifiees,
       p.stock_quantity AS stock_affiche, coalesce(rec.q, 0) AS recu, coalesce(ven.d, 0) AS livre, coalesce(adj.s, 0) AS ajustements,
       coalesce(rec.q, 0) - coalesce(ven.d, 0) + coalesce(adj.s, 0) AS stock_theorique,
       p.stock_quantity - (coalesce(rec.q, 0) - coalesce(ven.d, 0) + coalesce(adj.s, 0)) AS ecart
FROM lignes l JOIN products p ON p.id = l.product_id
LEFT JOIN rec ON rec.product_id = p.id LEFT JOIN ven ON ven.product_id = p.id LEFT JOIN adj ON adj.product_id = p.id
GROUP BY p.name, p.stock_quantity, rec.q, ven.d, adj.s
ORDER BY ecart DESC;
