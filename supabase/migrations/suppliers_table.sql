-- Fournisseurs et délais d'acheminement.
--
-- Le délai varie fortement par fournisseur, pas par produit : un fournisseur
-- local à La Réunion livre en quelques jours, un conteneur Pologne/Vietnam
-- prend 50 jours et plus. Le délai vit donc ici, au niveau du fournisseur,
-- products.delai_livraison_jours ne servant plus que d'exception ponctuelle.
--
-- Il n'y a pas de FK entre products et suppliers : le fournisseur d'un produit
-- est déduit de sa dernière réception (stock_receptions.supplier_name), comme
-- le font déjà /admin/reappro et le simulateur de commande. Le lien se fait
-- donc par nom, d'où la contrainte UNIQUE.

CREATE TABLE IF NOT EXISTS suppliers (
  id                    UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  name                  TEXT NOT NULL UNIQUE,
  delai_livraison_jours INTEGER CHECK (delai_livraison_jours IS NULL OR delai_livraison_jours >= 0),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE suppliers ENABLE ROW LEVEL SECURITY;
-- Aucune policy publique — accessible uniquement via la service role key
-- (pages admin), comme weekly_tasks, prospects et client_accounts.

CREATE INDEX IF NOT EXISTS suppliers_name_idx ON suppliers(name);

-- Pré-remplissage depuis les réceptions existantes, délai laissé à NULL :
-- à renseigner depuis /admin/fournisseurs. ON CONFLICT DO NOTHING rend la
-- migration rejouable sans écraser un délai déjà saisi.
INSERT INTO suppliers (name)
SELECT DISTINCT btrim(supplier_name)
FROM stock_receptions
WHERE supplier_name IS NOT NULL
  AND btrim(supplier_name) <> ''
ON CONFLICT (name) DO NOTHING;


-- ─────────────────────────────────────────────────────────────────────────
-- ÉTAPE 2 — OPTIONNELLE, À LANCER SÉPARÉMENT ET EN CONNAISSANCE DE CAUSE
-- ─────────────────────────────────────────────────────────────────────────
-- Les 61 produits portent actuellement TOUS delai_livraison_jours = 21.
-- C'est une valeur de seed uniforme, pas des exceptions choisies produit par
-- produit. Or la résolution du délai donne la priorité au produit :
--
--   1. products.delai_livraison_jours si renseigné   <-- gagne toujours ici
--   2. sinon le délai du fournisseur
--   3. sinon 30 j par défaut
--
-- Tant que ces 21 sont en place, l'étape 2 ne sera jamais atteinte et les
-- délais fournisseurs saisis dans /admin/fournisseurs n'auront aucun effet :
-- tous les produits afficheront « 21 j · produit ».
--
-- Décommenter pour vider ces valeurs uniformes et laisser le délai fournisseur
-- prendre la main. À ne faire que si aucun de ces 21 n'est une exception
-- réellement voulue. Vérifier d'abord :
--
--   SELECT delai_livraison_jours, count(*) FROM products GROUP BY 1;
--
-- UPDATE products SET delai_livraison_jours = NULL WHERE delai_livraison_jours = 21;


-- ─────────────────────────────────────────────────────────────────────────
-- À VÉRIFIER : doublon probable
-- ─────────────────────────────────────────────────────────────────────────
-- « ECO OI » et « ECO-OI » sont insérés comme deux fournisseurs distincts
-- (chaînes différentes). S'il s'agit bien du même, harmoniser le nom dans
-- stock_receptions puis supprimer la ligne en trop, sinon le délai devra être
-- saisi deux fois et un produit prendra l'un ou l'autre selon sa dernière
-- réception :
--
--   UPDATE stock_receptions SET supplier_name = 'ECO OI' WHERE supplier_name = 'ECO-OI';
--   DELETE FROM suppliers WHERE name = 'ECO-OI';
