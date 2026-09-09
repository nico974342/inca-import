-- Point 4 du retour "commande-fournisseur v2" : les quantités retenues à la
-- main sur /admin/commande-fournisseur ne survivaient qu'en localStorage —
-- perdues en changeant d'ordinateur. Table dédiée, liée à l'admin ET au
-- produit (le fournisseur voyage avec, pour l'affichage/regroupement, mais
-- n'entre pas dans la clé : un produit n'a qu'un fournisseur résolu à la
-- fois côté calcul).
--
-- localStorage reste un cache de secours côté client (lecture immédiate
-- avant que l'appel réseau ne réponde), jamais la seule sauvegarde.

CREATE TABLE IF NOT EXISTS commande_fournisseur_drafts (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_email    text NOT NULL,
  product_id     uuid NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  supplier_name  text NOT NULL,
  quantity       integer NOT NULL CHECK (quantity >= 0),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (admin_email, product_id)
);

CREATE INDEX IF NOT EXISTS commande_fournisseur_drafts_admin_idx
  ON commande_fournisseur_drafts (admin_email);

-- Idempotence de "Marquer comme commandé" : le bouton génère une clé côté
-- navigateur, réutilisée pour toute tentative issue du MÊME clic (double-
-- clic, requête réseau rejouée) — un deuxième appel avec la même clé
-- retourne l'expédition déjà créée au lieu d'en insérer une seconde.
-- Nullable + index unique PARTIEL : les expéditions déjà existantes (créées
-- ailleurs, sans clé) ne sont pas concernées et ne se bloquent pas entre
-- elles via des NULL en conflit.

ALTER TABLE shipments
  ADD COLUMN IF NOT EXISTS idempotency_key uuid;

CREATE UNIQUE INDEX IF NOT EXISTS shipments_idempotency_key_idx
  ON shipments (idempotency_key) WHERE idempotency_key IS NOT NULL;
