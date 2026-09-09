-- Point 1 de la demande "commande-fournisseur v2" : les fiches produits
-- étaient pré-remplies à 21 j (DEFAULT historique de la colonne) et cette
-- valeur primait sur le délai fournisseur, sans qu'on puisse distinguer une
-- vraie exception d'un reliquat du défaut jamais confirmé.
--
-- delai_livraison_override rend l'exception EXPLICITE : le délai produit
-- n'est utilisé par resolveDelaiLivraison (src/lib/constants.ts) que si ce
-- drapeau est à true. Reprise volontairement conservatrice : aucune valeur
-- existante n'est effacée, mais AUCUNE n'est promue "confirmée" non plus —
-- override reste à false pour toutes les lignes existantes, y compris celles
-- qui portent une vraie valeur (7 j) ou l'ancien défaut (21 j). C'est à
-- l'utilisateur de confirmer chaque cas via /admin/produits ; en attendant,
-- delaiAVerifier() (constants.ts) permet de lister ces lignes ambiguës sans
-- qu'elles n'influencent silencieusement un seul calcul.
--
-- commande_min_cartons / commande_multiple_cartons : contraintes d'achat par
-- produit (le fournisseur ne vend qu'au carton, à la palette, etc.), lues
-- par applyMoqAndMultiple (constants.ts) pour arrondir la quantité suggérée.
-- Nullable : NULL = "pas de contrainte connue", aucun changement de
-- comportement pour un produit qui n'a pas encore ces valeurs renseignées.

ALTER TABLE products
  ADD COLUMN IF NOT EXISTS delai_livraison_override BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS commande_min_cartons INTEGER,
  ADD COLUMN IF NOT EXISTS commande_multiple_cartons INTEGER;

ALTER TABLE products
  ADD CONSTRAINT products_commande_min_cartons_check
    CHECK (commande_min_cartons IS NULL OR commande_min_cartons > 0);

ALTER TABLE products
  ADD CONSTRAINT products_commande_multiple_cartons_check
    CHECK (commande_multiple_cartons IS NULL OR commande_multiple_cartons > 0);
