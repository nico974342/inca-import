-- schema_v9.sql
-- Track when a product's stock was last adjusted
-- Run this in Supabase SQL editor

ALTER TABLE products
  ADD COLUMN IF NOT EXISTS stock_updated_at TIMESTAMPTZ;
