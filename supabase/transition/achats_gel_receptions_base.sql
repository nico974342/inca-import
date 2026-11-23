-- GEL DES RÉCEPTIONS AU NIVEAU DE LA BASE — étape de la transition vers les réceptions partielles. NON APPLIQUÉ en production. Ce fichier n'est PAS une migration.
--
-- Effet : retire à service_role (le seul rôle qu'utilise le site) le droit d'EXÉCUTER les trois fonctions historiques de réception :
--   reception_create, reception_update, reception_delete.
-- Aucune ancienne version du site, aucun onglet resté ouvert, aucune autre route ne peut alors créer, corriger ou supprimer une réception : la base refuse AVANT d'exécuter
-- la moindre instruction de la fonction (permission denied) — donc ni stock, ni réception, ni PUMP, ni cumul ne sont touchés. Instantané (aucun verrou de table).
-- Ne touche à AUCUNE donnée, AUCUNE table, AUCUNE autre fonction (ajustement manuel de stock, commandes clients, PUMP : inchangés).
-- Les transactions déjà commencées vont à leur terme ; c'est pourquoi on vérifie ensuite qu'aucune opération n'est en cours (achats_receptions_partielles_avant_migration.sql).
--
-- AUTO-VÉRIFICATION (dans la même transaction) : après le retrait, le script contrôle les DROITS EFFECTIFS — y compris ceux hérités de PUBLIC ou d'un autre rôle auquel
-- service_role appartiendrait. Si un rôle autre que le propriétaire (et les super-utilisateurs) peut encore exécuter une de ces fonctions, il s'arrête avec GEL_INEFFICACE
-- et ANNULE tout : le gel n'est alors pas posé et on le sait. Réversible à l'identique par achats_degel_receptions_base.sql.

BEGIN;

REVOKE EXECUTE ON FUNCTION
  reception_create(text, date, text, boolean, jsonb, uuid),
  reception_update(uuid, text, date, text, boolean, jsonb, uuid),
  reception_delete(uuid)
  FROM PUBLIC, anon, authenticated, service_role;

DO $$
DECLARE
  f regprocedure; encore text; public_ouvert boolean;
BEGIN
  FOREACH f IN ARRAY ARRAY['reception_create(text, date, text, boolean, jsonb, uuid)'::regprocedure,
                           'reception_update(uuid, text, date, text, boolean, jsonb, uuid)'::regprocedure,
                           'reception_delete(uuid)'::regprocedure] LOOP
    SELECT string_agg(r.rolname, ', ' ORDER BY r.rolname) INTO encore
      FROM pg_roles r, pg_proc p
     WHERE p.oid = f AND NOT r.rolsuper AND r.oid <> p.proowner AND has_function_privilege(r.oid, f, 'EXECUTE');
    IF encore IS NOT NULL THEN
      RAISE EXCEPTION 'GEL_INEFFICACE : % reste exécutable par : % (droit hérité ou accordé autrement). Rien n''est appliqué.', f, encore;
    END IF;
    SELECT EXISTS (SELECT 1 FROM pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a WHERE p.oid = f AND a.grantee = 0 AND a.privilege_type = 'EXECUTE') INTO public_ouvert;
    IF public_ouvert THEN RAISE EXCEPTION 'GEL_INEFFICACE : % reste exécutable par PUBLIC. Rien n''est appliqué.', f; END IF;
  END LOOP;
END $$;

COMMIT;
