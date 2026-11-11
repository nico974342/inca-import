-- DÉGEL DES RÉCEPTIONS AU NIVEAU DE LA BASE — rend à service_role le droit d'exécuter les trois fonctions historiques de réception (état EXACT d'avant le gel).
-- NON APPLIQUÉ en production. Ce fichier n'est PAS une migration. À n'exécuter qu'à la REPRISE DU SERVICE (nouveau parcours confirmé), ou pour revenir à l'état d'avant le gel.
--
-- Droits rendus : service_role UNIQUEMENT (le site en a besoin pour les réceptions libres hors commande). Jamais PUBLIC, anon ni authenticated.
-- Ces fonctions ne peuvent pas créer, rattacher ni corriger une réception de COMMANDE : la base l'interdit (protections de la migration) ; le cumul des lignes de commande
-- ne s'écrit que par la nouvelle opération atomique. Le dégel ne rouvre donc aucun contournement, tant que le code en ligne est le nouveau.
-- RÈGLE : tout retour à une version antérieure du site (retour instantané Vercel) doit être précédé d'un NOUVEAU GEL.
--
-- AUTO-VÉRIFICATION (dans la même transaction) : après l'octroi, le script contrôle que service_role peut exécuter, que ni anon, ni authenticated, ni PUBLIC ne le peuvent, et
-- qu'aucun autre rôle (hors propriétaire et super-utilisateurs) n'a ce droit. Sinon : DEGEL_REFUSE et tout est annulé (les fonctions restent gelées). Aucune donnée touchée. Rejouable.

BEGIN;

GRANT EXECUTE ON FUNCTION
  reception_create(text, date, text, boolean, jsonb, uuid),
  reception_update(uuid, text, date, text, boolean, jsonb, uuid),
  reception_delete(uuid)
  TO service_role;

DO $$
DECLARE
  f regprocedure; autres text; public_ouvert boolean;
BEGIN
  FOREACH f IN ARRAY ARRAY['reception_create(text, date, text, boolean, jsonb, uuid)'::regprocedure,
                           'reception_update(uuid, text, date, text, boolean, jsonb, uuid)'::regprocedure,
                           'reception_delete(uuid)'::regprocedure] LOOP
    IF NOT has_function_privilege('service_role', f, 'EXECUTE') THEN RAISE EXCEPTION 'DEGEL_REFUSE : service_role ne peut pas exécuter % après l''octroi.', f; END IF;
    SELECT string_agg(r.rolname, ', ' ORDER BY r.rolname) INTO autres
      FROM pg_roles r, pg_proc p
     WHERE p.oid = f AND NOT r.rolsuper AND r.oid <> p.proowner AND r.rolname <> 'service_role' AND has_function_privilege(r.oid, f, 'EXECUTE');
    IF autres IS NOT NULL THEN RAISE EXCEPTION 'DEGEL_REFUSE : % est exécutable par d''autres rôles que service_role : % (état inattendu : tout est annulé, les fonctions restent gelées).', f, autres; END IF;
    SELECT EXISTS (SELECT 1 FROM pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a WHERE p.oid = f AND a.grantee = 0 AND a.privilege_type = 'EXECUTE') INTO public_ouvert;
    IF public_ouvert THEN RAISE EXCEPTION 'DEGEL_REFUSE : % est exécutable par PUBLIC (état inattendu : tout est annulé).', f; END IF;
  END LOOP;
END $$;

COMMIT;
