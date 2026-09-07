-- Point 3 (audit externe) : l'édition d'une commande existante pouvait
-- survendre. order_create_checked vérifie le disponible (physique − réservé)
-- à la création, mais l'édition (src/pages/api/admin/orders/[id]/update.ts)
-- comparait la nouvelle quantité au stock PHYSIQUE seul, en dehors de toute
-- transaction verrouillée.
--
-- Exemple concret : 10 cartons en stock. Commande A en réserve 6 (statut
-- confirmee), commande B en réserve 4. Éditer B à 6 était accepté car
-- 6 < 10 (physique), alors que 6 (A) + 6 (B) = 12 > 10 dépasse le disponible
-- réel.
--
-- order_update_checked devient le SEUL chemin d'édition autorisé par
-- l'application (voir updateOrderChecked dans src/lib/stock.ts), avec la même
-- exigence que order_create_checked : verrou, recalcul du disponible, et
-- écriture atomique — jamais de vérification-puis-écriture en étapes
-- séparées.
--
-- Le disponible ne peut pas être recalculé via la vue product_availability
-- telle quelle : elle inclut la commande en cours d'édition dans son propre
-- total réservé, ce qui la bloquerait sur sa propre réservation. On calcule
-- donc ici le réservé par les AUTRES commandes uniquement (o.id <>
-- p_order_id), en réutilisant stock_reserving_statuses() pour rester aligné
-- sur la vue et sur STOCK_RESERVING_STATUSES côté application.
--
-- L'édition reste réservée aux commandes non encore livrées
-- (isOrderEditable côté application) : une commande livrée a déjà décrémenté
-- le stock physique, sa modification relève d'un autre mécanisme (retour,
-- correction post-livraison — point 6 de l'audit), pas de celui-ci.

CREATE OR REPLACE FUNCTION public.order_update_checked(p_order_id uuid, p_items jsonb)
 RETURNS TABLE(r_conflicts jsonb)
 LANGUAGE plpgsql
AS $function$
DECLARE
  v_conflicts jsonb;
BEGIN
  IF p_items IS NULL OR jsonb_array_length(p_items) = 0 THEN
    RAISE EXCEPTION 'order_update_checked: aucune ligne';
  END IF;

  -- Verrou sur la commande elle-même en premier (sérialise deux éditions
  -- concurrentes de la même commande), puis sur les produits concernés par id
  -- croissant — même ordre de verrouillage que order_create_checked pour
  -- limiter le risque d'interblocage entre les deux fonctions.
  PERFORM 1 FROM orders WHERE id = p_order_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'order_update_checked: commande introuvable';
  END IF;

  PERFORM 1
  FROM products
  WHERE id IN (
    SELECT DISTINCT (it->>'product_id')::uuid
    FROM jsonb_array_elements(p_items) it
    WHERE it->>'product_id' IS NOT NULL
  )
  ORDER BY id
  FOR UPDATE;

  -- Disponible recalculé maintenant, verrous tenus, en excluant les propres
  -- lignes de la commande éditée de la réservation des « autres ».
  WITH req AS (
    SELECT (it->>'product_id')::uuid AS product_id,
           SUM((it->>'quantity')::int)::int AS qty
    FROM jsonb_array_elements(p_items) it
    WHERE it->>'product_id' IS NOT NULL
    GROUP BY 1
  ),
  reserved_others AS (
    SELECT oi.product_id, SUM(oi.quantity)::int AS qty
    FROM order_items oi
    JOIN orders o ON o.id = oi.order_id
    WHERE o.status = ANY(stock_reserving_statuses())
      AND o.id <> p_order_id
      AND oi.product_id IS NOT NULL
    GROUP BY oi.product_id
  )
  SELECT jsonb_agg(jsonb_build_object(
           'product_id',   req.product_id,
           'product_name', COALESCE(p.name, 'Produit inconnu'),
           'requested',    req.qty,
           'available',    GREATEST(0, COALESCE(p.stock_quantity, 0) - COALESCE(ro.qty, 0))
         ) ORDER BY p.name)
    INTO v_conflicts
  FROM req
  LEFT JOIN products p          ON p.id = req.product_id
  LEFT JOIN reserved_others ro  ON ro.product_id = req.product_id
  WHERE p.id IS NULL                                                              -- produit disparu
     OR req.qty > GREATEST(0, COALESCE(p.stock_quantity, 0) - COALESCE(ro.qty, 0));

  IF v_conflicts IS NOT NULL THEN
    r_conflicts := v_conflicts;
    RETURN NEXT;
    RETURN;
  END IF;

  -- Tout passe : diff atomique des lignes.
  -- 1) Quantité mise à jour pour les lignes déjà présentes.
  UPDATE order_items oi
  SET quantity = (it->>'quantity')::int
  FROM jsonb_array_elements(p_items) it
  WHERE oi.order_id = p_order_id
    AND oi.product_id = (it->>'product_id')::uuid
    AND oi.quantity <> (it->>'quantity')::int;

  -- 2) Nouvelles lignes (produit pas encore présent sur cette commande).
  INSERT INTO order_items (
    order_id, product_id, product_name, quantity, unit,
    price_ht_snapshot, tva_rate_snapshot, pump_snapshot
  )
  SELECT p_order_id,
         (it->>'product_id')::uuid,
         it->>'product_name',
         (it->>'quantity')::int,
         NULLIF(it->>'unit', ''),
         NULLIF(it->>'price_ht_snapshot', '')::numeric,
         NULLIF(it->>'tva_rate_snapshot', '')::numeric,
         NULLIF(it->>'pump_snapshot', '')::numeric
  FROM jsonb_array_elements(p_items) it
  WHERE NOT EXISTS (
    SELECT 1 FROM order_items oi
    WHERE oi.order_id = p_order_id AND oi.product_id = (it->>'product_id')::uuid
  );

  -- 3) Lignes retirées (produit présent avant, absent de p_items).
  DELETE FROM order_items oi
  WHERE oi.order_id = p_order_id
    AND oi.product_id IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM jsonb_array_elements(p_items) it
      WHERE (it->>'product_id')::uuid = oi.product_id
    );

  r_conflicts := '[]'::jsonb;
  RETURN NEXT;
END;
$function$;
