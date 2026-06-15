-- schema_v8.sql
-- Add stock_quantity column to products table
-- Run this in Supabase SQL editor

ALTER TABLE products
  ADD COLUMN IF NOT EXISTS stock_quantity INTEGER NOT NULL DEFAULT 0;
