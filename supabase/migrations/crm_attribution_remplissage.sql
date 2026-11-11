-- CRM — ÉTAPE 1 (M1), partie 2 : rattachement des commandes existantes à leur compte client.
-- NON APPLIQUÉE en production. À lancer APRÈS crm_attribution.sql, et seulement après vérification du rapport de correspondance
-- (nombre de commandes à rattacher = nombre attendu, 0 correspondance multiple).
--
-- SEULE donnée modifiée : orders.client_id, et seulement pour une commande qui :
--   * n'a pas encore de client_id ;
--   * est « historique » (jamais touchée par le CRM) ;
--   * a un e-mail qui désigne EXACTEMENT UN compte client (comparaison sans casse ni espaces).
-- Une correspondance multiple ou absente n'est jamais devinée : la commande reste sans client.
-- Ne touche NI au responsable, NI à l'attribution (toutes les commandes existantes restent « Historique non attribué »),
-- NI aux montants, statuts, stocks, BL. Rejouable (ne traite que les commandes encore sans client).

BEGIN;

-- Réglage valable pour cette transaction seulement : autorise le rattachement d'une commande HISTORIQUE (voir orders_attribution_proteger).
SELECT set_config('inca.rattachement_historique', '1', true);

DO $$
DECLARE
  v_a_traiter int; v_unique int; v_multiple int; v_aucune int; v_lie int;
BEGIN
  WITH c AS (
    SELECT o.id, count(a.id) n
    FROM orders o LEFT JOIN client_accounts a ON lower(trim(a.email)) = lower(trim(o.email))
    WHERE o.client_id IS NULL AND o.attribution = 'historique' AND nullif(trim(o.email), '') IS NOT NULL
    GROUP BY o.id)
  SELECT count(*), count(*) FILTER (WHERE n = 1), count(*) FILTER (WHERE n > 1), count(*) FILTER (WHERE n = 0)
    INTO v_a_traiter, v_unique, v_multiple, v_aucune FROM c;

  WITH cible AS (
    SELECT o.id AS order_id, (array_agg(a.id))[1] AS client_id
    FROM orders o JOIN client_accounts a ON lower(trim(a.email)) = lower(trim(o.email))
    WHERE o.client_id IS NULL AND o.attribution = 'historique' AND nullif(trim(o.email), '') IS NOT NULL
    GROUP BY o.id
    HAVING count(*) = 1)
  UPDATE orders o SET client_id = cible.client_id FROM cible WHERE o.id = cible.order_id;
  GET DIAGNOSTICS v_lie = ROW_COUNT;

  RAISE NOTICE 'M1 remplissage : % commandes historiques sans client examinées ; % rattachées (correspondance unique) ; % laissées sans client (correspondances multiples) ; % laissées sans client (aucun compte)',
    v_a_traiter, v_lie, v_multiple, v_aucune;
  IF v_lie <> v_unique THEN RAISE EXCEPTION 'M1 remplissage : incohérence (% rattachées pour % correspondances uniques) — transaction annulée', v_lie, v_unique; END IF;
END $$;

COMMIT;
