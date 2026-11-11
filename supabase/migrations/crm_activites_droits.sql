-- CRM — M2 : moindre privilège pour service_role sur les tables du suivi commercial.
-- NON APPLIQUÉE en production : à exécuter seulement sur accord explicite, APRÈS crm_activites.sql (déjà appliquée).
-- Uniquement des REVOKE : aucune donnée, aucune structure, aucune fonction modifiée. Rejouable sans effet.
--
-- Pourquoi : les déclencheurs de crm_activites.sql refusent déjà DELETE/TRUNCATE sur les activités, relances et délégations, mais le serveur
-- (service_role) ne doit même pas avoir le droit de les tenter. Les fonctions M2 sont toutes SECURITY INVOKER et n'utilisent que :
--   client_interactions : SELECT, INSERT, UPDATE        crm_delegations : SELECT, INSERT, UPDATE
--   client_contacts     : SELECT, INSERT, UPDATE, DELETE (contact_supprimer, journalisé)
--   crm_suggestions_masquees : SELECT, INSERT, UPDATE   weekly_tasks : SELECT, INSERT, UPDATE (aucune page ne supprime de tâche)
-- Les suppressions en cascade (suppression d'un compte client) sont exécutées par le propriétaire des tables, pas par service_role.

BEGIN;

REVOKE DELETE, TRUNCATE, REFERENCES, TRIGGER ON client_interactions      FROM service_role;
REVOKE DELETE, TRUNCATE, REFERENCES, TRIGGER ON crm_delegations          FROM service_role;
REVOKE DELETE, TRUNCATE, REFERENCES, TRIGGER ON crm_suggestions_masquees FROM service_role;
REVOKE DELETE, TRUNCATE, REFERENCES, TRIGGER ON weekly_tasks             FROM service_role;
REVOKE TRUNCATE, REFERENCES, TRIGGER         ON client_contacts          FROM service_role;

-- Fonctions de déclencheur : jamais appelées directement. Un déclencheur s'exécute sans que l'appelant ait le droit EXECUTE (contrôlé à la création du déclencheur).
-- Les 17 autres fonctions restent exécutables par service_role : les 14 appelées par le serveur (dont crm_aujourdhui et crm_peut_agir) et les
-- 3 aides internes (crm_verifier_acteur, crm_titre_action, crm_peut_gerer_relance) qu'elles appellent en SECURITY INVOKER.
REVOKE EXECUTE ON FUNCTION client_interactions_proteger(), weekly_tasks_proteger(), crm_delegations_proteger() FROM service_role;

COMMIT;

-- Retour arrière : GRANT DELETE, TRUNCATE, REFERENCES, TRIGGER ON <table> TO service_role; (état antérieur de crm_activites.sql).
