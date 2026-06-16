-- schema_v10.sql
-- schema_v7 updated the orders_status_check constraint to the new workflow
-- stages (en_attente, confirmee, ...) but never updated the column DEFAULT,
-- which was left at the old value 'recu'. Any insert that didn't explicitly
-- set status (every order-creation code path did not) was rejected with
-- "violates check constraint orders_status_check".
-- Run this in the Supabase SQL editor.

ALTER TABLE orders ALTER COLUMN status SET DEFAULT 'en_attente';
