-- Badge « Nouveau » du catalogue client. Additif : 5 colonnes sur products + 1 trigger. Ne modifie ni stock, ni prix, ni commandes.
-- Idempotent (rejouable). Appliquer AVANT de déployer le code correspondant.
--
-- Distinction historique / nouveau :
--   nouveau_eligible = false → produit historique : jamais « nouveau » automatiquement (activation manuelle possible).
--   nouveau_eligible = true  → produit créé APRÈS cette migration : badge automatique à sa première entrée en stock.
--   Aucune date fictive : premiere_entree_stock_le reste NULL pour les produits historiques.
--
-- Priorité : nouveau_mode = 'desactive' (désactivation volontaire) et 'manuel' priment toujours sur l'automatisme.
--   'auto'     : le trigger fixe la fenêtre (30 jours) à la première entrée en stock d'un produit éligible.
--   'manuel'   : fenêtre choisie à la main depuis la fiche produit.
--   'desactive': jamais affiché, jamais réactivé automatiquement.
-- Affichage (calculé à la lecture, aucune tâche planifiée) : mode <> 'desactive' AND debut <= now() < fin.

-- Colonne ajoutée avec false : toutes les lignes EXISTANTES deviennent historiques ; puis le défaut passe à true pour les futures.
ALTER TABLE products ADD COLUMN IF NOT EXISTS nouveau_eligible boolean NOT NULL DEFAULT false;
ALTER TABLE products ALTER COLUMN nouveau_eligible SET DEFAULT true;

ALTER TABLE products ADD COLUMN IF NOT EXISTS premiere_entree_stock_le timestamptz;
ALTER TABLE products ADD COLUMN IF NOT EXISTS nouveau_mode text NOT NULL DEFAULT 'auto';
ALTER TABLE products ADD COLUMN IF NOT EXISTS nouveau_debut timestamptz;
ALTER TABLE products ADD COLUMN IF NOT EXISTS nouveau_fin timestamptz;

DO $$ BEGIN
  ALTER TABLE products ADD CONSTRAINT products_nouveau_mode_check CHECK (nouveau_mode IN ('auto', 'manuel', 'desactive'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE products ADD CONSTRAINT products_nouveau_fenetre_check CHECK (nouveau_debut IS NULL OR nouveau_fin IS NULL OR nouveau_fin > nouveau_debut);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Première entrée en stock : jamais réinitialisée (la condition IS NULL l'interdit). Un réassort ne la touche donc pas.
CREATE OR REPLACE FUNCTION products_nouveau_premiere_entree() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NEW.nouveau_eligible AND NEW.premiere_entree_stock_le IS NULL AND NEW.stock_quantity > 0 THEN
    NEW.premiere_entree_stock_le := now();
    IF NEW.nouveau_mode = 'auto' AND NEW.nouveau_debut IS NULL THEN
      NEW.nouveau_debut := NEW.premiere_entree_stock_le;
      NEW.nouveau_fin   := NEW.premiere_entree_stock_le + interval '30 days';
    END IF;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_products_nouveau_premiere_entree ON products;
CREATE TRIGGER trg_products_nouveau_premiere_entree
  BEFORE INSERT OR UPDATE OF stock_quantity ON products
  FOR EACH ROW EXECUTE FUNCTION products_nouveau_premiere_entree();

-- Contrôle après application (lecture seule) :
--   select count(*) filter (where nouveau_eligible) as eligibles, count(*) as total from products;   -- eligibles = 0, total = 125
--   select count(*) from products where premiere_entree_stock_le is not null or nouveau_debut is not null;   -- 0
--
-- Retour arrière (retire la fonctionnalité, sans toucher au reste) :
--   DROP TRIGGER IF EXISTS trg_products_nouveau_premiere_entree ON products;
--   DROP FUNCTION IF EXISTS products_nouveau_premiere_entree();
--   ALTER TABLE products DROP COLUMN nouveau_eligible, DROP COLUMN premiere_entree_stock_le, DROP COLUMN nouveau_mode, DROP COLUMN nouveau_debut, DROP COLUMN nouveau_fin;
