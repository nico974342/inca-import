-- Run this in the Supabase SQL editor after schema_v2.sql

CREATE TABLE IF NOT EXISTS testimonials (
  id         UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  texte      TEXT NOT NULL,
  nom        TEXT NOT NULL,
  role       TEXT,
  actif      BOOLEAN DEFAULT TRUE,
  position   INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE testimonials ENABLE ROW LEVEL SECURITY;

-- Public read for active testimonials (used by landing page)
CREATE POLICY "Public can read active testimonials" ON testimonials
  FOR SELECT USING (actif = true);

-- Service role (admin) bypasses RLS automatically
