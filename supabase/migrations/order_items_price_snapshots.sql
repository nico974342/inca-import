-- C1: snapshot pricing on order_items so financial history stops depending
-- on current product prices. Run BEFORE deploying the code that writes/reads
-- these columns.
ALTER TABLE order_items ADD COLUMN IF NOT EXISTS price_ht_snapshot numeric;
ALTER TABLE order_items ADD COLUMN IF NOT EXISTS tva_rate_snapshot numeric;
ALTER TABLE order_items ADD COLUMN IF NOT EXISTS pump_snapshot     numeric;

-- Backfill existing rows with current product values (best available data).
UPDATE order_items oi
SET price_ht_snapshot = COALESCE(oi.price_ht_snapshot, p.price_ht),
    tva_rate_snapshot = COALESCE(oi.tva_rate_snapshot, p.tva_rate),
    pump_snapshot     = COALESCE(oi.pump_snapshot,     p.prix_achat_moyen_ht)
FROM products p
WHERE oi.product_id = p.id;
