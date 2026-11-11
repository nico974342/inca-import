-- GEL DES RÉCEPTIONS AU NIVEAU DE LA BASE — étape de la transition vers les réceptions partielles. NON APPLIQUÉ en production. Ce fichier n'est PAS une migration.
--
-- Effet : retire à service_role (le seul rôle qu'utilise le site) le droit d'EXÉCUTER les trois fonctions historiques de réception :
--   reception_create, reception_update, reception_delete.
-- Aucune ancienne version du site, aucun onglet resté ouvert, aucune autre route ne peut alors créer, corriger ou supprimer une réception : la base refuse (permission denied),
-- quel que soit le code qui appelle. Instantané (aucun verrou de table), réversible à l'identique par achats_degel_receptions_base.sql.
-- Ne touche à AUCUNE donnée, AUCUNE table, AUCUNE autre fonction (ajustement de stock, commandes clients, PUMP : inchangés).
-- Les transactions déjà commencées vont à leur terme ; c'est pourquoi on vérifie ensuite qu'aucune opération n'est en cours (achats_receptions_partielles_avant_migration.sql).

BEGIN;
REVOKE EXECUTE ON FUNCTION
  reception_create(text, date, text, boolean, jsonb, uuid),
  reception_update(uuid, text, date, text, boolean, jsonb, uuid),
  reception_delete(uuid)
  FROM PUBLIC, anon, authenticated, service_role;
COMMIT;
