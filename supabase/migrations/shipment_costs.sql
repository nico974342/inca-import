-- Frais d'import (fret, assurance, douane, octroi de mer, etc.) rattachés à
-- une expédition en transit, pour calculer le coût rendu dépôt de chaque
-- produit sans quitter le module Transit existant.
--
-- Comme shipments/shipment_items (voir shipments_table.sql), cette table est
-- du SUIVI : elle n'écrit jamais dans products, ne touche ni au stock ni au
-- PUMP. Le coût rendu qui en découle n'est appliqué au PUMP qu'au moment de
-- la réception, via reception_create — reception_create ne change pas ;
-- c'est l'appelant (/admin/reception/new) qui lui passe désormais le coût
-- rendu calculé ici comme unit_cost_ht, au lieu du prix fournisseur brut.
--
-- Un frais est soit général (product_id NULL), réparti au prorata de la
-- valeur fournisseur de chaque ligne de l'expédition, soit spécifique à un
-- produit (product_id renseigné), par exemple une taxe boisson ou un
-- étiquetage qui ne concerne qu'une partie de la cargaison. La répartition
-- elle-même est calculée à la volée côté application (src/lib/constants.ts,
-- computeLandedCosts) — rien n'est stocké de dérivé ici.
--
-- La TVA récupérable ne doit pas être saisie dans amount_ht : ce sont des
-- montants HT, au même titre que shipment_items.unit_cost_ht et
-- products.price_ht.

CREATE TABLE IF NOT EXISTS shipment_costs (
  id           UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  shipment_id  UUID NOT NULL REFERENCES shipments(id) ON DELETE CASCADE,
  -- NULL = frais général de l'expédition, réparti au prorata. Renseigné =
  -- frais imputé directement à ce produit.
  product_id   UUID REFERENCES products(id) ON DELETE SET NULL,
  label        TEXT NOT NULL,
  amount_ht    NUMERIC(10,2) NOT NULL CHECK (amount_ht >= 0),
  -- true tant que le montant est une prévision (le conteneur navigue encore),
  -- false une fois la facture définitive reçue.
  is_estimated BOOLEAN NOT NULL DEFAULT true,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE shipment_costs ENABLE ROW LEVEL SECURITY;
-- Aucune policy publique — accessible uniquement via la service role key
-- (pages admin), comme shipments/shipment_items.

CREATE INDEX IF NOT EXISTS shipment_costs_shipment_idx ON shipment_costs(shipment_id);
CREATE INDEX IF NOT EXISTS shipment_costs_product_idx  ON shipment_costs(product_id);

NOTIFY pgrst, 'reload schema';
