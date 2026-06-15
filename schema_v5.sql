-- Run in Supabase SQL editor after schema_v4.sql

-- Client profile: address and billing columns
ALTER TABLE client_accounts
  ADD COLUMN IF NOT EXISTS adresse_pdv          TEXT,
  ADD COLUMN IF NOT EXISTS livraison_rue         TEXT,
  ADD COLUMN IF NOT EXISTS livraison_ville       TEXT,
  ADD COLUMN IF NOT EXISTS livraison_code_postal TEXT,
  ADD COLUMN IF NOT EXISTS facturation_same      BOOLEAN DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS facturation_rue         TEXT,
  ADD COLUMN IF NOT EXISTS facturation_ville       TEXT,
  ADD COLUMN IF NOT EXISTS facturation_code_postal TEXT;
