-- RETOUR ARRIÈRE de supabase/migrations/crm_activites_droits.sql — à n'exécuter QUE si cette migration de droits pose un problème réel.
-- NON APPLIQUÉ en production. Ce fichier n'est PAS une migration : il vit hors de supabase/migrations pour ne jamais être rejoué par erreur.
--
-- Ce qu'il fait : rend à service_role exactement les droits que crm_activites_droits.sql lui a retirés (état de crm_activites.sql avec les droits par défaut) :
--   client_interactions, crm_delegations, crm_suggestions_masquees, weekly_tasks : DELETE, TRUNCATE, REFERENCES, TRIGGER
--   client_contacts : TRUNCATE, REFERENCES, TRIGGER (DELETE n'avait jamais été retiré)
--   les 3 fonctions de déclencheur : EXECUTE
-- Ce qu'il ne fait PAS : aucune donnée n'est lue, modifiée ni supprimée ; aucune table, colonne, fonction, déclencheur ni contrainte n'est créé ou
-- modifié ; les droits de anon et authenticated restent fermés ; les droits des autres tables (commandes, stocks, BL, signatures…) ne changent pas.
-- Indépendance : il ne dépend d'aucun autre fichier de migration (M1, M2, droits) et peut être exécuté seul, à n'importe quel moment, tant que les objets
-- ci-dessous existent (ils existent depuis l'application de crm_activites.sql). Il est rejouable sans effet.
-- Même après ce retour, les déclencheurs de crm_activites.sql continuent d'interdire la suppression et le vidage des activités, relances et délégations.

BEGIN;

GRANT DELETE, TRUNCATE, REFERENCES, TRIGGER ON client_interactions      TO service_role;
GRANT DELETE, TRUNCATE, REFERENCES, TRIGGER ON crm_delegations          TO service_role;
GRANT DELETE, TRUNCATE, REFERENCES, TRIGGER ON crm_suggestions_masquees TO service_role;
GRANT DELETE, TRUNCATE, REFERENCES, TRIGGER ON weekly_tasks             TO service_role;
GRANT TRUNCATE, REFERENCES, TRIGGER         ON client_contacts          TO service_role;

GRANT EXECUTE ON FUNCTION client_interactions_proteger(), weekly_tasks_proteger(), crm_delegations_proteger() TO service_role;

COMMIT;
