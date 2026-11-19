-- Réceptions : une modification ou une suppression n'applique QUE la différence de quantité (jamais « tout retirer puis tout remettre »).
--
-- ANOMALIE CORRIGÉE. reception_update retirait l'ancienne quantité avec GREATEST(0, stock − ancienne), puis ajoutait la nouvelle. Dès que le stock restant était
-- inférieur à la quantité d'origine (marchandise déjà vendue), le GREATEST bloquait à 0 : la différence disparaissait et la réception ENTIÈRE était remise en
-- stock. Exemple : stock 30, réception de 120 modifiée (même seulement son prix) → 0 puis 120 : 90 cartons déjà vendus recréés. reception_delete avait le même
-- blocage à 0 (retrait partiel silencieux).
--
-- RÈGLES (garanties ici, côté base, quelle que soit l'interface) :
--   1. Prix seul modifié (mêmes produits, mêmes quantités, même statut) : variation de stock = 0, aucune ligne de produit n'est touchée.
--   2. Quantité modifiée : seule la différence est appliquée (par produit, plusieurs produits possibles, un produit peut apparaître/disparaître).
--   3. Changement « historique ↔ appliquée » : la différence est calculée sur l'effet réel (appliquée = quantité, historique = 0).
--   4. Suppression d'une réception appliquée : retire exactement ses quantités, jamais plus ni moins.
--   5. Toute opération qui rendrait le stock négatif OU inférieur aux quantités réservées par les commandes en cours est REFUSÉE (message STOCK_INSUFFISANT_RECEPTION,
--      rien n'est écrit : la transaction est annulée).
--   6. Atomique : réception puis produits verrouillés (FOR UPDATE) dans un ordre fixe (réception, puis produits par identifiant) → pas d'interblocage, pas de mise à
--      jour perdue en cas de modifications simultanées.
--   7. Les commandes, livraisons, réservations, factures et autres mouvements ne sont jamais lus en écriture : seule la quantité des produits concernés change.
--
-- SIGNATURES, DROITS ET search_path INCHANGÉS (CREATE OR REPLACE conserve les droits : service_role uniquement). Une seule fonction interne est ajoutée.
-- reception_create n'est pas modifiée (elle ne fait qu'ajouter). Compatible avec la migration des réceptions partielles (elle ne redéfinit aucune de ces fonctions ;
-- ses protections de lignes rattachées à une commande s'appliquent avant, les réceptions historiques gardent ce comportement).
--
-- RETOUR ARRIÈRE : réappliquer les définitions d'origine (dlc_lots.sql pour reception_update, stock_rpc_functions.sql pour reception_delete),
--   puis DROP FUNCTION reception_ecarts_stock(uuid, boolean, boolean, jsonb).  Aucune donnée n'est créée ni modifiée par cette migration.

-- ── Écart de stock par produit (fonction interne, lecture seule) ─────────────────────────────────────────────
-- p_items NULL = suppression (aucune ligne après). Un produit présent dans l'ancienne ou la nouvelle réception apparaît une fois.
CREATE OR REPLACE FUNCTION public.reception_ecarts_stock(p_reception_id uuid, p_ancienne_appliquee boolean, p_nouvelle_appliquee boolean, p_items jsonb)
 RETURNS TABLE (product_id uuid, ancienne integer, nouvelle integer, ecart integer)
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
  WITH o AS (
    SELECT i.product_id AS pid, SUM(i.quantity)::int AS q FROM stock_reception_items i WHERE i.reception_id = p_reception_id GROUP BY 1
  ), n AS (
    SELECT (it->>'product_id')::uuid AS pid, SUM((it->>'quantity')::int)::int AS q
    FROM jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) it GROUP BY 1
  ), ids AS (
    SELECT pid FROM o UNION SELECT pid FROM n
  )
  SELECT ids.pid,
         CASE WHEN p_ancienne_appliquee THEN coalesce(o.q, 0) ELSE 0 END,
         CASE WHEN p_nouvelle_appliquee THEN coalesce(n.q, 0) ELSE 0 END,
         (CASE WHEN p_nouvelle_appliquee THEN coalesce(n.q, 0) ELSE 0 END) - (CASE WHEN p_ancienne_appliquee THEN coalesce(o.q, 0) ELSE 0 END)
  FROM ids LEFT JOIN o ON o.pid = ids.pid LEFT JOIN n ON n.pid = ids.pid;
$function$;

-- ── Refus si le stock deviendrait négatif ou inférieur au réservé (fonction interne) ─────────────────────────
CREATE OR REPLACE FUNCTION public.reception_verifier_ecarts(p_reception_id uuid, p_ancienne_appliquee boolean, p_nouvelle_appliquee boolean, p_items jsonb)
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v record;
BEGIN
  SELECT p.name, p.stock_quantity AS stock, e.ecart, coalesce(r.reserved, 0) AS reserve INTO v
  FROM reception_ecarts_stock(p_reception_id, p_ancienne_appliquee, p_nouvelle_appliquee, p_items) e
  JOIN products p ON p.id = e.product_id
  LEFT JOIN (
    SELECT oi.product_id, SUM(oi.quantity)::int AS reserved
    FROM order_items oi JOIN orders o ON o.id = oi.order_id
    WHERE o.status = ANY (stock_reserving_statuses()) GROUP BY 1
  ) r ON r.product_id = e.product_id
  WHERE e.ecart < 0 AND p.stock_quantity + e.ecart < GREATEST(0, coalesce(r.reserved, 0))
  ORDER BY p.name LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'STOCK_INSUFFISANT_RECEPTION : cette opération retirerait % carton(s) de « % » alors que le stock est de % et que % sont réservés par des commandes en cours. La marchandise a déjà été vendue : corrigez plutôt par un ajustement de stock justifié.',
      -v.ecart, v.name, v.stock, v.reserve USING ERRCODE = 'P0001';
  END IF;
END;
$function$;

-- ── reception_update : écart seulement ───────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.reception_update(p_reception_id uuid, p_supplier_name text, p_received_at date, p_notes text, p_stock_applied boolean, p_items jsonb, p_supplier_id uuid DEFAULT NULL::uuid)
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_old_applied boolean;
  v_pids        uuid[];
BEGIN
  SELECT stock_applied INTO v_old_applied
    FROM stock_receptions WHERE id = p_reception_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'reception % not found', p_reception_id;
  END IF;

  IF p_items IS NULL OR jsonb_typeof(p_items) <> 'array' OR jsonb_array_length(p_items) = 0 THEN
    RAISE EXCEPTION 'RECEPTION_VIDE : une réception contient au moins une ligne';
  END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(p_items) it WHERE coalesce((it->>'quantity')::int, 0) <= 0 OR coalesce((it->>'unit_cost_ht')::numeric, 0) < 0) THEN
    RAISE EXCEPTION 'QUANTITE_INVALIDE : quantité strictement positive et coût non négatif exigés';
  END IF;

  -- Verrou des produits concernés (anciens ∪ nouveaux), toujours dans le même ordre.
  SELECT array_agg(pid ORDER BY pid) INTO v_pids FROM (
    SELECT product_id AS pid FROM stock_reception_items WHERE reception_id = p_reception_id
    UNION
    SELECT (it->>'product_id')::uuid FROM jsonb_array_elements(p_items) it
  ) u;
  PERFORM 1 FROM products WHERE id = ANY (v_pids) ORDER BY id FOR UPDATE;

  PERFORM reception_verifier_ecarts(p_reception_id, v_old_applied, p_stock_applied, p_items);

  -- Seule la DIFFÉRENCE est appliquée ; un produit dont l'écart est nul n'est pas touché (prix seul = aucune variation).
  UPDATE products p
  SET stock_quantity = p.stock_quantity + e.ecart,
      in_stock       = (p.stock_quantity + e.ecart) > 0
  FROM reception_ecarts_stock(p_reception_id, v_old_applied, p_stock_applied, p_items) e
  WHERE p.id = e.product_id AND e.ecart <> 0;

  DELETE FROM stock_reception_items WHERE reception_id = p_reception_id;

  INSERT INTO stock_reception_items (reception_id, product_id, quantity, unit_cost_ht, dlc)
  SELECT p_reception_id,
         (it->>'product_id')::uuid,
         (it->>'quantity')::int,
         (it->>'unit_cost_ht')::numeric,
         NULLIF(it->>'dlc', '')::date
  FROM jsonb_array_elements(p_items) it;

  UPDATE stock_receptions
  SET supplier_name = p_supplier_name,
      supplier_id   = p_supplier_id,
      received_at   = p_received_at,
      notes         = p_notes,
      stock_applied = p_stock_applied
  WHERE id = p_reception_id;

  PERFORM recalc_pump(v_pids);
END;
$function$;

-- ── reception_delete : retire exactement les quantités de la réception, ou refuse ───────────────────────────
CREATE OR REPLACE FUNCTION public.reception_delete(p_reception_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_applied boolean;
  v_pids    uuid[];
BEGIN
  SELECT stock_applied INTO v_applied
    FROM stock_receptions WHERE id = p_reception_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'reception % not found', p_reception_id;
  END IF;

  SELECT array_agg(DISTINCT product_id ORDER BY product_id) INTO v_pids
    FROM stock_reception_items WHERE reception_id = p_reception_id;

  IF v_pids IS NOT NULL THEN
    PERFORM 1 FROM products WHERE id = ANY (v_pids) ORDER BY id FOR UPDATE;
  END IF;

  IF v_applied THEN
    PERFORM reception_verifier_ecarts(p_reception_id, true, false, NULL);
    UPDATE products p
    SET stock_quantity = p.stock_quantity + e.ecart,
        in_stock       = (p.stock_quantity + e.ecart) > 0
    FROM reception_ecarts_stock(p_reception_id, true, false, NULL) e
    WHERE p.id = e.product_id AND e.ecart <> 0;
  END IF;

  DELETE FROM stock_receptions WHERE id = p_reception_id; -- cascades to items

  IF v_pids IS NOT NULL THEN
    PERFORM recalc_pump(v_pids);
  END IF;
END;
$function$;

-- Fonctions internes : mêmes droits que les fonctions de réception (service_role uniquement).
REVOKE ALL ON FUNCTION public.reception_ecarts_stock(uuid, boolean, boolean, jsonb)    FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.reception_verifier_ecarts(uuid, boolean, boolean, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reception_ecarts_stock(uuid, boolean, boolean, jsonb)    TO service_role;
GRANT EXECUTE ON FUNCTION public.reception_verifier_ecarts(uuid, boolean, boolean, jsonb) TO service_role;
