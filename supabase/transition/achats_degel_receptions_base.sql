-- DÉGEL DES RÉCEPTIONS AU NIVEAU DE LA BASE — rend à service_role le droit d'exécuter les trois fonctions historiques de réception (état d'avant le gel).
-- NON APPLIQUÉ en production. Ce fichier n'est PAS une migration. À n'exécuter qu'à la REPRISE DU SERVICE (nouveau parcours confirmé), ou pour revenir à l'état d'avant le gel.
-- Seul service_role reçoit le droit : anon et authenticated restent fermés, comme avant. Aucune donnée touchée. Rejouable sans effet.

BEGIN;
GRANT EXECUTE ON FUNCTION
  reception_create(text, date, text, boolean, jsonb, uuid),
  reception_update(uuid, text, date, text, boolean, jsonb, uuid),
  reception_delete(uuid)
  TO service_role;
COMMIT;
