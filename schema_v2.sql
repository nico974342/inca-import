-- ============================================================
-- Inca Import — schema v2 migration
-- Run this in the Supabase SQL editor after schema.sql
-- ============================================================

-- Cart items (one row per user × product)
CREATE TABLE IF NOT EXISTS cart_items (
  id          UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id     UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  product_id  UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  quantity    INTEGER NOT NULL DEFAULT 1 CHECK (quantity > 0),
  updated_at  TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, product_id)
);

ALTER TABLE cart_items ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users manage own cart" ON cart_items
  FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- Orders
CREATE TABLE IF NOT EXISTS orders (
  id          UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id     UUID NOT NULL REFERENCES auth.users(id),
  nom         TEXT,
  societe     TEXT,
  telephone   TEXT,
  email       TEXT,
  status      TEXT DEFAULT 'recu' CHECK (status IN ('recu', 'confirme', 'livre', 'annule')),
  notes       TEXT,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE orders ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users see own orders" ON orders
  FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "Users insert own orders" ON orders
  FOR INSERT WITH CHECK (auth.uid() = user_id);

-- Order items (snapshot at time of order)
CREATE TABLE IF NOT EXISTS order_items (
  id            UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  order_id      UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  product_id    UUID REFERENCES products(id) ON DELETE SET NULL,
  product_name  TEXT NOT NULL,
  quantity      INTEGER NOT NULL CHECK (quantity > 0),
  unit          TEXT,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE order_items ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users see own order items" ON order_items
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM orders o
      WHERE o.id = order_items.order_id AND o.user_id = auth.uid()
    )
  );

CREATE POLICY "Users insert own order items" ON order_items
  FOR INSERT WITH CHECK (
    EXISTS (
      SELECT 1 FROM orders o
      WHERE o.id = order_items.order_id AND o.user_id = auth.uid()
    )
  );

-- Index for fast cart lookups
CREATE INDEX IF NOT EXISTS cart_items_user_id_idx ON cart_items(user_id);
CREATE INDEX IF NOT EXISTS orders_user_id_idx ON orders(user_id);
