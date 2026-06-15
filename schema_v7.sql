-- schema_v7.sql
-- Migration: Update order status values to new workflow stages
-- Run this in Supabase SQL editor

BEGIN;

-- Migrate existing rows to new status names
UPDATE orders SET status = 'en_attente'  WHERE status = 'recu';
UPDATE orders SET status = 'confirmee'   WHERE status = 'confirme';
UPDATE orders SET status = 'livree'      WHERE status = 'livre';
UPDATE orders SET status = 'annulee'     WHERE status = 'annule';

-- Drop old check constraint
ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_status_check;

-- Add new constraint with updated status values
ALTER TABLE orders
  ADD CONSTRAINT orders_status_check
  CHECK (status IN ('en_attente', 'confirmee', 'en_preparation', 'expediee', 'livree', 'annulee'));

COMMIT;
