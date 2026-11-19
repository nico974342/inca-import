/**
 * Implémentation INDÉPENDANTE (requête récursive, lecture seule) de la méthode CUMP v2, reprise de la simulation présentée au responsable : sert d'oracle aux tests du moteur.
 * Pour un produit ($1) : une ligne par vente livrée {item_id, cout (NULL si non couverte), couvert}.
 * Règles : réceptions appliquées à leur date (minuit, Réunion) ; réceptions historiques = stock d'ouverture disponible dès l'origine ; ventes à la date de livraison tracée (sinon date de commande) ;
 * ajustements manuels : hausse de provenance inconnue = jamais valorisée (réserve « u »), doublon d'une réception historique ignoré, baisse = annule d'abord la réserve puis sortie réelle au coût moyen.
 */
export const SIMULATION_V2 = `WITH RECURSIVE
  tr AS (SELECT a.target_id, max(a.created_at) t FROM admin_audit_logs a WHERE a.action='commande.statut' AND a.details->>'nouveau'='livree' GROUP BY 1),
  ev AS (SELECT *, row_number() OVER (ORDER BY t, k, tie) n FROM (
    SELECT 0 k, CASE WHEN r.stock_applied THEN (r.received_at::timestamp AT TIME ZONE 'Indian/Reunion') ELSE timestamptz '1970-01-01' END t, i.quantity qty, i.unit_cost_ht cost, NULL::uuid item_id, i.id tie, false dbl
      FROM stock_reception_items i JOIN stock_receptions r ON r.id=i.reception_id WHERE i.product_id=$1 AND (to_jsonb(r)->>'annulee_le') IS NULL
    UNION ALL SELECT 1, coalesce(tr.t, o.created_at), oi.stock_decremented, NULL::numeric, oi.id, oi.id, false FROM order_items oi JOIN orders o ON o.id=oi.order_id LEFT JOIN tr ON tr.target_id=o.id::text WHERE oi.product_id=$1 AND oi.stock_decremented>0
    UNION ALL SELECT 2, a.created_at, (a.details->>'apres')::int-(a.details->>'avant')::int, NULL::numeric, NULL::uuid, a.id,
      ((a.details->>'avant')::int=0 AND (a.details->>'apres')::int>0 AND EXISTS (SELECT 1 FROM stock_reception_items i2 JOIN stock_receptions r2 ON r2.id=i2.reception_id WHERE i2.product_id=$1 AND NOT r2.stock_applied AND i2.quantity=(a.details->>'apres')::int AND (to_jsonb(r2)->>'annulee_le') IS NULL))
      FROM admin_audit_logs a WHERE a.action='produit.stock_ajustement' AND a.target_id=$1::text AND coalesce(a.details->>'avant','') ~ '^-?[0-9]+$' AND coalesce(a.details->>'apres','') ~ '^-?[0-9]+$') x),
  st(n, q, avg, u, k, item_id, cout, couvert) AS (
    SELECT 0::bigint, 0::numeric, NULL::numeric, 0, NULL::int, NULL::uuid, NULL::numeric, NULL::boolean
    UNION ALL SELECT e.n,
      CASE WHEN e.k=0 THEN s.q+e.qty WHEN e.k=1 THEN greatest(0, s.q-e.qty) WHEN e.qty<0 THEN greatest(0, s.q - greatest(0, -e.qty - s.u)) ELSE s.q END,
      CASE WHEN e.k=0 THEN CASE WHEN s.q<=0 OR s.avg IS NULL THEN e.cost ELSE (s.q*s.avg+e.qty*e.cost)/(s.q+e.qty) END ELSE s.avg END,
      CASE WHEN e.k=2 THEN CASE WHEN e.qty>0 AND NOT e.dbl THEN s.u+e.qty WHEN e.qty<0 THEN s.u - least(s.u, -e.qty) ELSE s.u END ELSE s.u END,
      e.k, e.item_id, CASE WHEN e.k=1 AND s.q>=e.qty THEN s.avg END, CASE WHEN e.k=1 THEN s.q>=e.qty END
    FROM st s JOIN ev e ON e.n=s.n+1)
  SELECT item_id, cout, couvert FROM st WHERE k=1`;
