-- Stock de sécurité par fournisseur, en jours.
--
-- Ajouté au besoin calculé par le simulateur de commande fournisseur :
--   sécurité (cartons) = vitesse_ajustée × jours_securite / 7
-- et utilisé pour repousser d'autant la date d'arrivée dans la comparaison
-- de l'alerte de rupture (rupture < arrivée + jours_securite) — un conteneur
-- qui arrive pile le jour où le stock tombe à zéro est déjà une situation
-- dangereuse, pas une situation qui vient tout juste d'être évitée.
--
-- Nullable, défaut 0 : aucun changement de comportement pour un fournisseur
-- qui n'a pas encore cette valeur renseignée.

ALTER TABLE suppliers
  ADD COLUMN IF NOT EXISTS jours_securite INTEGER DEFAULT 0
    CHECK (jours_securite IS NULL OR jours_securite >= 0);
