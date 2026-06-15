-- ============================================================
-- Inca Import — Supabase Schema
-- Run this in the Supabase Studio SQL editor
-- ============================================================

-- Products
CREATE TABLE IF NOT EXISTS products (
  id          UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  name        TEXT NOT NULL,
  slug        TEXT UNIQUE NOT NULL,
  category    TEXT NOT NULL CHECK (category IN ('boissons', 'snacks', 'confiseries')),
  description TEXT,
  sku         TEXT,
  price_ht    NUMERIC(10, 2),
  unit        TEXT DEFAULT 'carton',
  image_url   TEXT,
  in_stock    BOOLEAN DEFAULT true,
  position    INTEGER DEFAULT 0,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- Contact requests (from landing page form)
CREATE TABLE IF NOT EXISTS contact_requests (
  id        UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  nom       TEXT NOT NULL,
  societe   TEXT,
  telephone TEXT,
  email     TEXT,
  status    TEXT DEFAULT 'nouveau' CHECK (status IN ('nouveau', 'contacte', 'converti', 'rejete')),
  notes     TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Client accounts
CREATE TABLE IF NOT EXISTS client_accounts (
  id                  UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  contact_request_id  UUID REFERENCES contact_requests(id),
  nom                 TEXT NOT NULL,
  societe             TEXT,
  telephone           TEXT,
  email               TEXT UNIQUE,
  status              TEXT DEFAULT 'en_attente' CHECK (status IN ('en_attente', 'actif', 'suspendu')),
  notes               TEXT,
  created_at          TIMESTAMPTZ DEFAULT NOW()
);

-- ── RLS ──────────────────────────────────────────────────────
ALTER TABLE products          ENABLE ROW LEVEL SECURITY;
ALTER TABLE contact_requests  ENABLE ROW LEVEL SECURITY;
ALTER TABLE client_accounts   ENABLE ROW LEVEL SECURITY;

-- Public can read in-stock products (for the catalog page)
CREATE POLICY "Public read in-stock products"
  ON products FOR SELECT
  USING (in_stock = true);

-- contact_requests and client_accounts are accessible only via the
-- service role key (used server-side in admin pages). No public policies.

-- ── Indexes ──────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS products_category_idx  ON products(category);
CREATE INDEX IF NOT EXISTS products_position_idx  ON products(position);
CREATE INDEX IF NOT EXISTS contacts_status_idx    ON contact_requests(status);
CREATE INDEX IF NOT EXISTS contacts_created_idx   ON contact_requests(created_at DESC);
CREATE INDEX IF NOT EXISTS clients_status_idx     ON client_accounts(status);
