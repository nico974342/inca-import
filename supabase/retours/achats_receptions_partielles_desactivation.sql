-- RETOUR ARRIÈRE de supabase/migrations/achats_receptions_partielles.sql — procédure B : DÉSACTIVATION, à utiliser dès que de VRAIES réceptions de commande existent.
-- NON APPLIQUÉ en production. Ce fichier n'est PAS une migration : il vit hors de supabase/migrations pour ne jamais être rejoué par erreur.
--
-- Principe : on ne supprime RIEN. Les réceptions déjà enregistrées ont mis le stock à jour ; leurs lignes, cumuls, archives et historiques sont la trace de ces entrées.
-- Ce script retire seulement le droit d'EXÉCUTER les trois fonctions d'écriture (plus aucune nouvelle réception, annulation ni changement de quantité par la base) ;
-- les déclencheurs de protection restent actifs : les réceptions rattachées à une commande, leurs lignes et les cumuls restent immuables et cohérents.
-- Les fonctions de lecture (shipment_reception_etat / _quantites) restent disponibles : la fiche de commande et la liste continuent d'afficher quantités et historique.
-- Réversible à l'identique : voir la dernière section (REGRANT), qui rend le droit.
--
-- À combiner avec le redéploiement de la version précédente de l'interface UNIQUEMENT si nécessaire : l'ancienne interface écrit directement le cumul des lignes, ce que
-- les déclencheurs refusent désormais (CUMUL_PROTEGE) pour toute ligne déjà concernée. Préférer conserver la nouvelle interface (lecture seule des réceptions, boutons
-- d'écriture en erreur explicite « fonction indisponible ») et corriger en avant.

BEGIN;

REVOKE EXECUTE ON FUNCTION
  reception_commande_enregistrer(uuid, uuid, date, text, text, jsonb, uuid, text, text),
  reception_commande_annuler(uuid, text, uuid, text, text),
  shipment_item_quantite_modifier(uuid, integer, text, uuid, text, text)
  FROM PUBLIC, anon, authenticated, service_role;

COMMIT;

-- REGRANT (réactiver) :
--   GRANT EXECUTE ON FUNCTION
--     reception_commande_enregistrer(uuid, uuid, date, text, text, jsonb, uuid, text, text),
--     reception_commande_annuler(uuid, text, uuid, text, text),
--     shipment_item_quantite_modifier(uuid, integer, text, uuid, text, text) TO service_role;
