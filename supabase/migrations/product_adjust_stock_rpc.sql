-- ⚠ SUPERSÉDÉ par product_adjust_stock_fix.sql — NE PAS REJOUER.
--
-- Cette version écrit stock_updated_at, colonne ajoutée par schema_v9.sql,
-- jamais lancé. Elle échouait donc à chaque appel et les boutons +/− de
-- /admin/stocks ne modifiaient rien, l'erreur étant ravalée par l'API.
-- Rejouer ce fichier recasserait la fonction. Le fichier est conservé pour
-- l'historique ; la version en service est celle du fix.
--
-- M1: atomic delta adjustment for manual stock edits (/api/produits/stocks).
-- Clamps at 0 and keeps in_stock/stock_updated_at coherent in one statement.
CREATE OR REPLACE FUNCTION product_adjust_stock(p_product_id uuid, p_delta int)
RETURNS int
LANGUAGE plpgsql AS $$
DECLARE
  v_new int;
BEGIN
  UPDATE products
  SET stock_quantity   = GREATEST(0, stock_quantity + p_delta),
      in_stock         = GREATEST(0, stock_quantity + p_delta) > 0,
      stock_updated_at = NOW()
  WHERE id = p_product_id
  RETURNING stock_quantity INTO v_new;
  RETURN v_new;
END;
$$;

REVOKE EXECUTE ON FUNCTION product_adjust_stock(uuid, int) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION product_adjust_stock(uuid, int) TO service_role;
