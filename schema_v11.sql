-- schema_v11.sql
-- Links client_accounts rows to their auth.users account, created when a
-- visitor completes /inscription. Needed to merge /admin/contacts and
-- /admin/clients into one unified admin view.
-- Run this in the Supabase SQL editor.

ALTER TABLE client_accounts ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES auth.users(id);
CREATE INDEX IF NOT EXISTS idx_client_accounts_user_id ON client_accounts(user_id);
