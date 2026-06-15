-- Run in Supabase SQL editor after schema_v3.sql

-- Add points de vente to client accounts
ALTER TABLE client_accounts ADD COLUMN IF NOT EXISTS points_de_vente TEXT;
