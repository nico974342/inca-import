-- H1 + H2: atomic stock mutations.
-- Run BEFORE deploying the code that calls these functions.
--
-- H1: order_items.stock_decremented records how much stock was ACTUALLY
--     removed when an order went "livree" (the decrement clamps at 0), so
--     cancelling restores exactly that amount — no more phantom stock.
-- H2: reception create/update/delete and order stock changes each run in a
--     single transaction inside Postgres; a mid-way failure rolls back
--     everything instead of leaving stock/PUMP half-updated.

-- ── H1: track the actually-decremented quantity per order line ────────────
ALTER TABLE order_items ADD COLUMN IF NOT EXISTS stock_decremented integer;

-- Backfill: orders already "livree" are assumed fully decremented, which
-- preserves the pre-migration cancel behaviour for them.
UPDATE order_items oi
SET stock_decremented = oi.quantity
FROM orders o
WHERE o.id = oi.order_id
  AND o.status = 'livree'
  AND oi.product_id IS NOT NULL
  AND oi.stock_decremented IS NULL;

-- ── PUMP recalculation (weighted average over all reception items) ────────
CREATE OR REPLACE FUNCTION recalc_pump(p_product_ids uuid[])
RETURNS void
LANGUAGE sql AS $$
  UPDATE products p
  SET prix_achat_moyen_ht = sub.pump
  FROM (
    SELECT pid AS product_id,
           (SELECT ROUND(SUM(i.quantity * i.unit_cost_ht) / NULLIF(SUM(i.quantity), 0), 4)
              FROM stock_reception_items i
             WHERE i.product_id = pid) AS pump
    FROM unnest(p_product_ids) AS pid
  ) sub
  WHERE p.id = sub.product_id;
$$;

-- ── Reception: create ─────────────────────────────────────────────────────
-- p_items: [{"product_id": "<uuid>", "quantity": 3, "unit_cost_ht": 1.25}, …]
CREATE OR REPLACE FUNCTION reception_create(
  p_supplier_name text,
  p_received_at   date,
  p_notes         text,
  p_stock_applied boolean,
  p_items         jsonb
) RETURNS uuid
LANGUAGE plpgsql AS $$
DECLARE
  v_id   uuid;
  v_pids uuid[];
BEGIN
  INSERT INTO stock_receptions (supplier_name, received_at, notes, stock_applied)
  VALUES (p_supplier_name, p_received_at, p_notes, p_stock_applied)
  RETURNING id INTO v_id;

  INSERT INTO stock_reception_items (reception_id, product_id, quantity, unit_cost_ht)
  SELECT v_id,
         (it->>'product_id')::uuid,
         (it->>'quantity')::int,
         (it->>'unit_cost_ht')::numeric
  FROM jsonb_array_elements(p_items) it;

  SELECT array_agg(DISTINCT (it->>'product_id')::uuid)
    INTO v_pids
    FROM jsonb_array_elements(p_items) it;

  PERFORM recalc_pump(v_pids);

  IF p_stock_applied THEN
    UPDATE products p
    SET stock_quantity = p.stock_quantity + agg.qty,
        in_stock       = (p.stock_quantity + agg.qty) > 0
    FROM (
      SELECT (it->>'product_id')::uuid AS product_id,
             SUM((it->>'quantity')::int)::int AS qty
      FROM jsonb_array_elements(p_items) it
      GROUP BY 1
    ) agg
    WHERE p.id = agg.product_id;
  END IF;

  RETURN v_id;
END;
$$;

-- ── Reception: update (reverse old stock, replace items, reapply) ─────────
CREATE OR REPLACE FUNCTION reception_update(
  p_reception_id  uuid,
  p_supplier_name text,
  p_received_at   date,
  p_notes         text,
  p_stock_applied boolean,
  p_items         jsonb
) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  v_old_applied boolean;
  v_pids        uuid[];
BEGIN
  SELECT stock_applied INTO v_old_applied
    FROM stock_receptions WHERE id = p_reception_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'reception % not found', p_reception_id;
  END IF;

  IF v_old_applied THEN
    UPDATE products p
    SET stock_quantity = GREATEST(0, p.stock_quantity - old.qty),
        in_stock       = GREATEST(0, p.stock_quantity - old.qty) > 0
    FROM (
      SELECT product_id, SUM(quantity)::int AS qty
      FROM stock_reception_items
      WHERE reception_id = p_reception_id
      GROUP BY product_id
    ) old
    WHERE p.id = old.product_id;
  END IF;

  -- old ∪ new products all need their PUMP recalculated
  SELECT array_agg(DISTINCT pid) INTO v_pids FROM (
    SELECT product_id AS pid FROM stock_reception_items WHERE reception_id = p_reception_id
    UNION
    SELECT (it->>'product_id')::uuid FROM jsonb_array_elements(p_items) it
  ) u;

  DELETE FROM stock_reception_items WHERE reception_id = p_reception_id;

  INSERT INTO stock_reception_items (reception_id, product_id, quantity, unit_cost_ht)
  SELECT p_reception_id,
         (it->>'product_id')::uuid,
         (it->>'quantity')::int,
         (it->>'unit_cost_ht')::numeric
  FROM jsonb_array_elements(p_items) it;

  UPDATE stock_receptions
  SET supplier_name = p_supplier_name,
      received_at   = p_received_at,
      notes         = p_notes,
      stock_applied = p_stock_applied
  WHERE id = p_reception_id;

  PERFORM recalc_pump(v_pids);

  IF p_stock_applied THEN
    UPDATE products p
    SET stock_quantity = p.stock_quantity + agg.qty,
        in_stock       = (p.stock_quantity + agg.qty) > 0
    FROM (
      SELECT (it->>'product_id')::uuid AS product_id,
             SUM((it->>'quantity')::int)::int AS qty
      FROM jsonb_array_elements(p_items) it
      GROUP BY 1
    ) agg
    WHERE p.id = agg.product_id;
  END IF;
END;
$$;

-- ── Reception: delete (reverse applied stock, cascade items, recalc) ──────
CREATE OR REPLACE FUNCTION reception_delete(p_reception_id uuid)
RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  v_applied boolean;
  v_pids    uuid[];
BEGIN
  SELECT stock_applied INTO v_applied
    FROM stock_receptions WHERE id = p_reception_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'reception % not found', p_reception_id;
  END IF;

  SELECT array_agg(DISTINCT product_id) INTO v_pids
    FROM stock_reception_items WHERE reception_id = p_reception_id;

  IF v_applied THEN
    UPDATE products p
    SET stock_quantity = GREATEST(0, p.stock_quantity - old.qty),
        in_stock       = GREATEST(0, p.stock_quantity - old.qty) > 0
    FROM (
      SELECT product_id, SUM(quantity)::int AS qty
      FROM stock_reception_items
      WHERE reception_id = p_reception_id
      GROUP BY product_id
    ) old
    WHERE p.id = old.product_id;
  END IF;

  DELETE FROM stock_receptions WHERE id = p_reception_id; -- cascades to items

  IF v_pids IS NOT NULL THEN
    PERFORM recalc_pump(v_pids);
  END IF;
END;
$$;

-- ── Order: mark livree (clamped decrement, records actual amount) ─────────
-- Skips lines already decremented, so livree → X → livree never double-
-- decrements. Returns the touched products for low-stock alerting.
CREATE OR REPLACE FUNCTION order_mark_livree(p_order_id uuid)
RETURNS TABLE (r_product_id uuid, r_name text, r_new_qty int)
LANGUAGE plpgsql AS $$
DECLARE
  r       record;
  v_stock int;
  v_dec   int;
BEGIN
  FOR r IN
    SELECT oi.id AS item_id, oi.product_id, oi.quantity
    FROM order_items oi
    WHERE oi.order_id = p_order_id
      AND oi.product_id IS NOT NULL
      AND oi.stock_decremented IS NULL
  LOOP
    SELECT stock_quantity, name INTO v_stock, r_name
      FROM products WHERE id = r.product_id FOR UPDATE;
    IF NOT FOUND THEN CONTINUE; END IF;

    v_dec := LEAST(v_stock, r.quantity);

    UPDATE products
    SET stock_quantity = v_stock - v_dec,
        in_stock       = (v_stock - v_dec) > 0
    WHERE id = r.product_id;

    UPDATE order_items SET stock_decremented = v_dec WHERE id = r.item_id;

    r_product_id := r.product_id;
    r_new_qty    := v_stock - v_dec;
    RETURN NEXT;
  END LOOP;
END;
$$;

-- ── Order: cancel after livree (restore exactly what was decremented) ─────
CREATE OR REPLACE FUNCTION order_cancel_livree(p_order_id uuid)
RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT oi.id AS item_id, oi.product_id,
           COALESCE(oi.stock_decremented, 0) AS restored_qty
    FROM order_items oi
    WHERE oi.order_id = p_order_id
      AND oi.product_id IS NOT NULL
      AND COALESCE(oi.stock_decremented, 0) > 0
  LOOP
    UPDATE products
    SET stock_quantity = stock_quantity + r.restored_qty,
        in_stock       = true
    WHERE id = r.product_id;

    UPDATE order_items SET stock_decremented = NULL WHERE id = r.item_id;
  END LOOP;
END;
$$;

-- ── Lock down: only the service role may execute these ────────────────────
REVOKE EXECUTE ON FUNCTION recalc_pump(uuid[])                                    FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION reception_create(text, date, text, boolean, jsonb)     FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION reception_update(uuid, text, date, text, boolean, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION reception_delete(uuid)                                 FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION order_mark_livree(uuid)                                FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION order_cancel_livree(uuid)                              FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION recalc_pump(uuid[])                                     TO service_role;
GRANT EXECUTE ON FUNCTION reception_create(text, date, text, boolean, jsonb)      TO service_role;
GRANT EXECUTE ON FUNCTION reception_update(uuid, text, date, text, boolean, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION reception_delete(uuid)                                  TO service_role;
GRANT EXECUTE ON FUNCTION order_mark_livree(uuid)                                 TO service_role;
GRANT EXECUTE ON FUNCTION order_cancel_livree(uuid)                               TO service_role;
