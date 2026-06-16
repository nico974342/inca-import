-- schema_v12.sql
-- Adds commercial terms to client_accounts (discount rate, payment terms,
-- credit limit) so the admin client detail page can track them per client.
-- Run this in the Supabase SQL editor.

ALTER TABLE client_accounts ADD COLUMN IF NOT EXISTS remise NUMERIC(5,2);
ALTER TABLE client_accounts ADD COLUMN IF NOT EXISTS conditions_paiement TEXT CHECK (conditions_paiement IN ('comptant', '30j', '60j'));
ALTER TABLE client_accounts ADD COLUMN IF NOT EXISTS plafond_credit NUMERIC(10,2);
