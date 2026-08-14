-- Stock réservé : empêcher la survente entre la commande et la livraison.
--
-- Le stock physique (products.stock_quantity) ne décrémente qu'au passage en
-- « livrée ». Entre la commande et la livraison, la marchandise est donc
-- engagée mais toujours comptée comme vendable : trois clients pouvaient
-- commander 10 cartons chacun sur 20 en stock, et les trois passaient.
--
--   physique  = products.stock_quantity
--   réservé   = Σ order_items.quantity des commandes en_attente / confirmee
--               / en_preparation / expediee
--   disponible = physique − réservé
--
-- « livree » est exclu des réservations parce que le physique a déjà été
-- décrémenté : au moment du passage en livrée, la réservation disparaît et le
-- physique baisse d'autant, donc le disponible ne bouge pas. « annulee » est
-- exclu aussi, ce qui libère la réservation.

-- ── Statuts qui immobilisent du stock ────────────────────────────────────
CREATE OR REPLACE FUNCTION stock_reserving_statuses()
RETURNS text[] LANGUAGE sql IMMUTABLE AS $$
  SELECT ARRAY['en_attente', 'confirmee', 'en_preparation', 'expediee']::text[];
$$;

-- ── Vue de disponibilité : la définition vit ici, une seule fois ─────────
-- `available` n'est volontairement pas borné à 0 : une valeur négative
-- signale une survente déjà encaissée, information que l'admin doit voir.
CREATE OR REPLACE VIEW product_availability AS
SELECT
  p.id                                                AS product_id,
  p.name                                              AS product_name,
  p.stock_quantity                                    AS physical,
  COALESCE(r.reserved, 0)                             AS reserved,
  p.stock_quantity - COALESCE(r.reserved, 0)          AS available
FROM products p
LEFT JOIN (
  SELECT oi.product_id, SUM(oi.quantity)::int AS reserved
  FROM order_items oi
  JOIN orders o ON o.id = oi.order_id
  WHERE o.status = ANY (stock_reserving_statuses())
    AND oi.product_id IS NOT NULL
  GROUP BY oi.product_id
) r ON r.product_id = p.id;

-- L'agrégat est relu à chaque commande : sans index, chaque validation
-- balaie order_items en entier.
CREATE INDEX IF NOT EXISTS order_items_product_order_idx ON order_items(product_id, order_id);
CREATE INDEX IF NOT EXISTS orders_status_idx             ON orders(status);

-- ── Création de commande contrôlée, en une seule transaction ─────────────
-- Le contrôle et l'insertion partagent la même transaction, et les lignes
-- products concernées sont verrouillées d'abord : deux commandes simultanées
-- sur le même produit se sérialisent au lieu de passer toutes les deux.
--
-- p_order : {user_id, nom, societe, telephone, email, notes}
-- p_items : [{product_id, product_name, quantity, unit,
--             price_ht_snapshot, tva_rate_snapshot, pump_snapshot}, …]
--
-- Retour : (r_order_id, r_conflicts). Si r_conflicts n'est pas vide, RIEN
-- n'a été inséré et r_order_id est NULL — le conflit décrit chaque ligne
-- refusée avec le disponible réel, pour que l'appelant puisse le dire.
CREATE OR REPLACE FUNCTION order_create_checked(
  p_order jsonb,
  p_items jsonb
) RETURNS TABLE (r_order_id uuid, r_conflicts jsonb)
LANGUAGE plpgsql AS $$
DECLARE
  v_order_id  uuid;
  v_conflicts jsonb;
BEGIN
  IF p_items IS NULL OR jsonb_array_length(p_items) = 0 THEN
    RAISE EXCEPTION 'order_create_checked: aucune ligne';
  END IF;

  -- Verrou par id croissant : deux commandes portant les mêmes produits dans
  -- un ordre différent se bloqueraient mutuellement sans ce tri.
  PERFORM 1
  FROM products
  WHERE id IN (
    SELECT DISTINCT (it->>'product_id')::uuid
    FROM jsonb_array_elements(p_items) it
    WHERE it->>'product_id' IS NOT NULL
  )
  ORDER BY id
  FOR UPDATE;

  -- Disponible recalculé maintenant, verrous tenus.
  WITH req AS (
    SELECT (it->>'product_id')::uuid AS product_id,
           SUM((it->>'quantity')::int)::int AS qty
    FROM jsonb_array_elements(p_items) it
    WHERE it->>'product_id' IS NOT NULL
    GROUP BY 1
  )
  SELECT jsonb_agg(jsonb_build_object(
           'product_id',   req.product_id,
           'product_name', COALESCE(p.name, 'Produit inconnu'),
           'requested',    req.qty,
           'available',    GREATEST(0, COALESCE(a.available, 0))
         ) ORDER BY p.name)
    INTO v_conflicts
  FROM req
  LEFT JOIN products p             ON p.id = req.product_id
  LEFT JOIN product_availability a ON a.product_id = req.product_id
  WHERE p.id IS NULL                                    -- produit disparu
     OR req.qty > GREATEST(0, COALESCE(a.available, 0));

  IF v_conflicts IS NOT NULL THEN
    r_order_id  := NULL;
    r_conflicts := v_conflicts;
    RETURN NEXT;
    RETURN;
  END IF;

  INSERT INTO orders (user_id, nom, societe, telephone, email, notes, status)
  VALUES (
    NULLIF(p_order->>'user_id', '')::uuid,
    COALESCE(p_order->>'nom', ''),
    COALESCE(p_order->>'societe', ''),
    COALESCE(p_order->>'telephone', ''),
    NULLIF(p_order->>'email', ''),
    NULLIF(p_order->>'notes', ''),
    'en_attente'
  )
  RETURNING id INTO v_order_id;

  INSERT INTO order_items (
    order_id, product_id, product_name, quantity, unit,
    price_ht_snapshot, tva_rate_snapshot, pump_snapshot
  )
  SELECT v_order_id,
         (it->>'product_id')::uuid,
         it->>'product_name',
         (it->>'quantity')::int,
         NULLIF(it->>'unit', ''),
         NULLIF(it->>'price_ht_snapshot', '')::numeric,
         NULLIF(it->>'tva_rate_snapshot', '')::numeric,
         NULLIF(it->>'pump_snapshot', '')::numeric
  FROM jsonb_array_elements(p_items) it;

  r_order_id  := v_order_id;
  r_conflicts := '[]'::jsonb;
  RETURN NEXT;
END;
$$;

-- ── Verrouillage : service role uniquement, comme les autres RPC stock ───
REVOKE EXECUTE ON FUNCTION stock_reserving_statuses()                FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION order_create_checked(jsonb, jsonb)        FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION stock_reserving_statuses()                TO service_role;
GRANT  EXECUTE ON FUNCTION order_create_checked(jsonb, jsonb)        TO service_role;

REVOKE ALL ON product_availability FROM PUBLIC, anon, authenticated;
GRANT  SELECT ON product_availability TO service_role;
