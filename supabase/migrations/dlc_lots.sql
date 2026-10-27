-- Suivi des DLC (dates limites de consommation) par lot reçu.
--
-- La DLC appartient au LOT (une ligne de réception), pas au produit : le même
-- produit reçu en juin et en octobre n'a pas la même date. Le produit ne porte
-- qu'une durée de conservation TYPE, utilisée uniquement pour PRÉ-REMPLIR la
-- DLC à la saisie d'une réception — jamais pour la remplacer ni la calculer.
--
-- La DLC est une information de SUIVI : elle ne modifie ni les quantités, ni le
-- PUMP, ni les réservations. Les fonctions reception_create / reception_update
-- ci-dessous sont reprises à l'identique (stock, PUMP, verrous) ; seule
-- l'insertion des lignes écrit en plus la colonne dlc.
--
-- À LANCER AVANT de déployer le code correspondant.
-- Aucun changement de comportement à la migration : colonnes NULL partout.

-- ── 1. Colonnes ─────────────────────────────────────────────────────────
ALTER TABLE products
  ADD COLUMN IF NOT EXISTS duree_conservation_mois integer;

ALTER TABLE products
  DROP CONSTRAINT IF EXISTS products_duree_conservation_mois_check;
ALTER TABLE products
  ADD CONSTRAINT products_duree_conservation_mois_check
  CHECK (duree_conservation_mois IS NULL OR (duree_conservation_mois > 0 AND duree_conservation_mois <= 120));

ALTER TABLE stock_reception_items
  ADD COLUMN IF NOT EXISTS dlc date;

-- Les alertes parcourent les lots d'un produit et ceux qui ont une DLC.
CREATE INDEX IF NOT EXISTS stock_reception_items_product_idx
  ON stock_reception_items (product_id);

-- ── 2. reception_create : écrit aussi la DLC de chaque ligne ──────────────
-- p_items : [{ product_id, quantity, unit_cost_ht, dlc? }] — dlc au format
-- AAAA-MM-JJ, absente ou vide = NULL (« non renseignée »).
-- CREATE OR REPLACE conserve les droits EXECUTE (service_role seul).
CREATE OR REPLACE FUNCTION public.reception_create(p_supplier_name text, p_received_at date, p_notes text, p_stock_applied boolean, p_items jsonb, p_supplier_id uuid DEFAULT NULL::uuid)
 RETURNS uuid
 LANGUAGE plpgsql
AS $function$
DECLARE
  v_id   uuid;
  v_pids uuid[];
BEGIN
  INSERT INTO stock_receptions (supplier_name, supplier_id, received_at, notes, stock_applied)
  VALUES (p_supplier_name, p_supplier_id, p_received_at, p_notes, p_stock_applied)
  RETURNING id INTO v_id;

  INSERT INTO stock_reception_items (reception_id, product_id, quantity, unit_cost_ht, dlc)
  SELECT v_id,
         (it->>'product_id')::uuid,
         (it->>'quantity')::int,
         (it->>'unit_cost_ht')::numeric,
         NULLIF(it->>'dlc', '')::date
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
$function$;

-- ── 3. reception_update : idem ───────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.reception_update(p_reception_id uuid, p_supplier_name text, p_received_at date, p_notes text, p_stock_applied boolean, p_items jsonb, p_supplier_id uuid DEFAULT NULL::uuid)
 RETURNS void
 LANGUAGE plpgsql
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

  SELECT array_agg(DISTINCT pid) INTO v_pids FROM (
    SELECT product_id AS pid FROM stock_reception_items WHERE reception_id = p_reception_id
    UNION
    SELECT (it->>'product_id')::uuid FROM jsonb_array_elements(p_items) it
  ) u;

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
$function$;
