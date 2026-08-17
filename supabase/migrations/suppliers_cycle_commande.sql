-- Cycle de commande par fournisseur, en jours : le rythme réel auquel une
-- commande est repassée chez CE fournisseur (peut différer de son délai
-- d'acheminement — un fournisseur livré en 7 j peut n'être recommandé que
-- toutes les 3 semaines, par exemple).
--
-- Utilisé par le simulateur de commande fournisseur en mode Réassort :
--   couverture (semaines) = délai + cycle_de_commande
-- pour que les arrivages s'enchaînent sans rupture entre deux commandes.
--
-- Nullable : NULL signifie "pas de cycle propre renseigné" — le simulateur
-- retombe alors sur le délai d'acheminement du fournisseur ("je commande à
-- chaque arrivage"), lui-même déjà nullable avec son propre repli par
-- défaut. Aucun changement de comportement pour un fournisseur qui n'a pas
-- encore cette valeur renseignée.
--
-- > 0 et non >= 0 : contrairement au délai ou à la sécurité, un cycle de 0
-- jour n'a pas de sens (on ne peut pas repasser commande tous les 0 jours) —
-- 0 serait une valeur invalide, pas une valeur légitime à traiter comme
-- "aucun cycle".

ALTER TABLE suppliers
  ADD COLUMN IF NOT EXISTS cycle_commande_jours INTEGER DEFAULT NULL
    CHECK (cycle_commande_jours IS NULL OR cycle_commande_jours > 0);
