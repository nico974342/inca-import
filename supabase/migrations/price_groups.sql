-- Groupes tarifaires : vendre le même produit à des prix différents selon
-- le client, sans dupliquer le catalogue.
--
-- Résolution du prix, dans cet ordre :
--   1. price_group_items du groupe EFFECTIF du client (le sien, ou à défaut
--      le groupe is_default) si une ligne existe pour ce produit
--   2. sinon products.price_ht (le prix de base reste le repli universel)
--
-- Un groupe n'a donc besoin de contenir que les produits dont le prix
-- diffère du prix de base. La remise client (client_accounts.remise)
-- s'applique ensuite, par-dessus le prix résolu — elle ne disparaît pas.
--
-- Tant qu'aucun groupe n'existe (ou qu'aucun n'est marqué par défaut), la
-- résolution retombe intégralement sur products.price_ht : le comportement
-- actuel est donc strictement préservé pour tout client sans groupe assigné,
-- jusqu'à ce qu'un groupe par défaut soit créé et rempli.

CREATE TABLE IF NOT EXISTS price_groups (
  id         UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  name       TEXT UNIQUE NOT NULL,
  is_default BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Au plus une grille par défaut à la fois : c'est elle qui s'applique à tout
-- client dont price_group_id est NULL.
CREATE UNIQUE INDEX IF NOT EXISTS price_groups_one_default_idx
  ON price_groups (is_default) WHERE is_default;

CREATE TABLE IF NOT EXISTS price_group_items (
  id             UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  price_group_id UUID NOT NULL REFERENCES price_groups(id) ON DELETE CASCADE,
  product_id     UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  price_ht       NUMERIC(10, 2) NOT NULL,
  UNIQUE (price_group_id, product_id)
);

CREATE INDEX IF NOT EXISTS price_group_items_group_idx ON price_group_items(price_group_id);

ALTER TABLE client_accounts
  ADD COLUMN IF NOT EXISTS price_group_id UUID REFERENCES price_groups(id) ON DELETE SET NULL;

-- ── RLS ──────────────────────────────────────────────────────────────────
-- Même politique que client_accounts / contact_requests : ces tables ne
-- sont lues ou écrites que côté serveur, via la clé service_role. Pas de
-- policy publique.
ALTER TABLE price_groups      ENABLE ROW LEVEL SECURITY;
ALTER TABLE price_group_items ENABLE ROW LEVEL SECURITY;

-- ── Changer de grille par défaut, sans jamais en avoir deux à la fois ─────
-- Désactive l'ancien défaut puis active le nouveau dans la même transaction,
-- pour ne jamais dépendre de l'ordre d'appel côté client (deux UPDATE
-- séparés depuis l'app pourraient violer l'index unique entre les deux).
CREATE OR REPLACE FUNCTION price_group_set_default(p_id uuid)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  UPDATE price_groups SET is_default = false WHERE is_default AND id <> p_id;
  UPDATE price_groups SET is_default = true  WHERE id = p_id;
END;
$$;

REVOKE EXECUTE ON FUNCTION price_group_set_default(uuid) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION price_group_set_default(uuid) TO service_role;
