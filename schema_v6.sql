-- schema_v6.sql
-- Add units_per_carton to products table

ALTER TABLE products
  ADD COLUMN IF NOT EXISTS units_per_carton INTEGER;
