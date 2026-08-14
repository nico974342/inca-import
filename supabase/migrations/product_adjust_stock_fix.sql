-- Répare product_adjust_stock, qui échouait à chaque appel.
--
-- La fonction écrivait `stock_updated_at = NOW()`, colonne ajoutée par
-- schema_v9.sql — jamais lancé. Chaque appel levait donc :
--   column "stock_updated_at" of relation "products" does not exist
-- et l'API /api/produits/stocks journalisait l'erreur sans la remonter :
-- les boutons +/− de /admin/stocks ne modifiaient rien, en silence.
--
-- La colonne n'ayant jamais existé, l'horodatage n'a jamais été affiché non
-- plus. Plutôt que d'ajouter une colonne pour un champ dont personne ne s'est
-- servi, on retire la référence — c'est le correctif le plus simple, et il
-- remet les boutons en marche.

CREATE OR REPLACE FUNCTION product_adjust_stock(p_product_id uuid, p_delta integer)
RETURNS integer
LANGUAGE plpgsql AS $$
DECLARE
  v_new int;
BEGIN
  UPDATE products
  SET stock_quantity = GREATEST(0, stock_quantity + p_delta),
      in_stock       = GREATEST(0, stock_quantity + p_delta) > 0
  WHERE id = p_product_id
  RETURNING stock_quantity INTO v_new;
  RETURN v_new;
END;
$$;

REVOKE EXECUTE ON FUNCTION product_adjust_stock(uuid, integer) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION product_adjust_stock(uuid, integer) TO service_role;
