-- Per-order TVA rate: 0.085 (8.5%), 0.021 (2.1%), or any custom value
ALTER TABLE orders ADD COLUMN IF NOT EXISTS tva_rate numeric DEFAULT 0.085;
