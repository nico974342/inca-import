-- Suivi des expéditions fournisseurs en cours d'acheminement.
--
-- IMPORTANT — ces tables sont du suivi pur : elles ne touchent JAMAIS au
-- stock ni au PUMP. Une expédition est une marchandise partie de chez le
-- fournisseur mais pas encore arrivée ; elle n'existe pas encore
-- comptablement. Le stock et le PUMP ne bougent qu'à la réception réelle,
-- via la RPC reception_create appelée par /admin/reception/new.
--
-- Le passage transit -> stock se fait donc en deux temps :
--   1. l'expédition est saisie ici et suivie jusqu'à son arrivée
--   2. « Réceptionner » pré-remplit /admin/reception/new, dont la validation
--      applique le stock et recalcule le PUMP, puis bascule l'expédition en
--      statut 'receptionne' — elle sort alors de la liste active.
--
-- Aucun trigger, aucune écriture vers products : c'est délibéré.

CREATE TABLE IF NOT EXISTS shipments (
  id             UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  supplier_name  TEXT NOT NULL,
  -- Numéro de conteneur ou de BL fournisseur, optionnel.
  reference      TEXT,
  departure_date DATE,
  eta            DATE,
  status         TEXT NOT NULL DEFAULT 'commande'
                   CHECK (status IN ('commande', 'en_transit', 'arrive_port', 'dedouanement', 'receptionne')),
  notes          TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS shipment_items (
  id           UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  shipment_id  UUID NOT NULL REFERENCES shipments(id) ON DELETE CASCADE,
  product_id   UUID NOT NULL REFERENCES products(id),
  quantity     INTEGER NOT NULL CHECK (quantity > 0),
  unit_cost_ht NUMERIC(10,4) CHECK (unit_cost_ht IS NULL OR unit_cost_ht >= 0)
);

ALTER TABLE shipments      ENABLE ROW LEVEL SECURITY;
ALTER TABLE shipment_items ENABLE ROW LEVEL SECURITY;
-- Aucune policy publique — accessible uniquement via la service role key
-- (pages admin), comme suppliers, weekly_tasks et client_accounts.

-- L'ETA porte le tri de la liste active ; le statut filtre les réceptionnées.
CREATE INDEX IF NOT EXISTS shipments_eta_idx           ON shipments(eta);
CREATE INDEX IF NOT EXISTS shipments_status_idx        ON shipments(status);
-- Le simulateur agrège les quantités en transit par produit.
CREATE INDEX IF NOT EXISTS shipment_items_product_idx  ON shipment_items(product_id);
CREATE INDEX IF NOT EXISTS shipment_items_shipment_idx ON shipment_items(shipment_id);
