-- Persist BL number per order: generated once, reused on every download
ALTER TABLE orders ADD COLUMN IF NOT EXISTS bl_number TEXT;
