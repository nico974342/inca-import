-- Couverture cible après réception, par fournisseur, en jours.
--
-- Objectif de stock (ventes normales, hors sécurité) à tenir une fois la
-- marchandise reçue — voir computeReorderQtyWithBridge dans constants.ts.
-- Distinct du délai d'acheminement (délai_livraison_jours), de la sécurité
-- (jours_securite) et de l'ancien cycle_commande_jours (repli désormais
-- inutilisé par le moteur de calcul, conservé pour compatibilité avec la
-- donnée déjà saisie — voir le commentaire dans commande-fournisseur.astro).
--
-- NULL = non réglé pour ce fournisseur : la page retombe sur
-- COUVERTURE_CIBLE_DEFAUT_JOURS (30 j), sauf simulation globale active.
-- 0 n'a pas de sens ici (comme pour le cycle de commande) : rejeté par la
-- contrainte, une valeur vide reste NULL plutôt que 0.

ALTER TABLE suppliers
  ADD COLUMN IF NOT EXISTS couverture_cible_jours INTEGER
    CHECK (couverture_cible_jours IS NULL OR couverture_cible_jours > 0);
