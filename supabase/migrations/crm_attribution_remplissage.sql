-- CRM — ÉTAPE 1 (M1), partie 2 : rattachement des commandes existantes à leur compte client.
-- NON APPLIQUÉE en production. À lancer APRÈS crm_attribution.sql, une fois celle-ci contrôlée et conforme.
--
-- VERROUS : ce fichier REFUSE de s'exécuter (la transaction est annulée, rien n'est modifié) si :
--   * les valeurs attendues du rapport de correspondance ne sont pas fournies (réglages de session inca.remplissage_attendu_*, ci-dessous) ;
--   * une seule commande a une correspondance AMBIGUË (plusieurs comptes pour le même e-mail) ;
--   * les données ont changé depuis le rapport : nombre de commandes examinées, de correspondances uniques ou de commandes sans compte
--     différents de ceux attendus, ou empreinte (MD5) de la liste « commande → compte » différente.
-- Les valeurs attendues sont posées par l'opérateur dans le MÊME appel, juste avant ce fichier :
--   SELECT set_config('inca.remplissage_attendu_candidats', '<n>', false), set_config('inca.remplissage_attendu_uniques', '<n>', false),
--          set_config('inca.remplissage_attendu_aucune', '<n>', false),    set_config('inca.remplissage_attendu_empreinte', '<md5>', false);
--   (empreinte = md5(string_agg(commande_id || ':' || compte_id, ',' ORDER BY commande_id)) sur les correspondances uniques ; voir la procédure.)
-- puis remises à zéro (RESET) juste après.
--
-- SEULE donnée modifiée : orders.client_id, et seulement pour une commande qui :
--   * n'a pas encore de client_id ;
--   * est « historique » (jamais touchée par le CRM) ;
--   * a un e-mail qui désigne EXACTEMENT UN compte client (comparaison sans casse ni espaces) — JAMAIS par le nom ou la société.
-- Ne touche NI au responsable, NI à l'attribution, NI à la classification Groupe (toutes les commandes existantes restent
-- « Historique non attribué » / « non classé »), NI aux montants, statuts, stocks, BL. Rejouable (ne traite que les commandes sans client).

BEGIN;

-- Réglage valable pour cette transaction seulement : autorise le rattachement d'une commande HISTORIQUE (voir orders_attribution_proteger).
SELECT set_config('inca.rattachement_historique', '1', true);

DO $$
DECLARE
  a_cand text := nullif(current_setting('inca.remplissage_attendu_candidats', true), '');
  a_uniq text := nullif(current_setting('inca.remplissage_attendu_uniques', true), '');
  a_aucu text := nullif(current_setting('inca.remplissage_attendu_aucune', true), '');
  a_empr text := nullif(current_setting('inca.remplissage_attendu_empreinte', true), '');
  v_cand int; v_unique int; v_multiple int; v_aucune int; v_empreinte text; v_lie int;
BEGIN
  IF a_cand IS NULL OR a_uniq IS NULL OR a_aucu IS NULL OR a_empr IS NULL THEN
    RAISE EXCEPTION 'REMPLISSAGE_BLOQUE : les valeurs attendues du rapport de correspondance ne sont pas fournies (aucune écriture)';
  END IF;

  WITH c AS (
    SELECT o.id, count(a.id) n
    FROM orders o LEFT JOIN client_accounts a ON lower(trim(a.email)) = lower(trim(o.email))
    WHERE o.client_id IS NULL AND o.attribution = 'historique' AND nullif(trim(o.email), '') IS NOT NULL
    GROUP BY o.id)
  SELECT count(*), count(*) FILTER (WHERE n = 1), count(*) FILTER (WHERE n > 1), count(*) FILTER (WHERE n = 0)
    INTO v_cand, v_unique, v_multiple, v_aucune FROM c;

  SELECT md5(coalesce(string_agg(u.order_id::text || ':' || u.client_id::text, ',' ORDER BY u.order_id), ''))
    INTO v_empreinte
  FROM (SELECT o.id AS order_id, (array_agg(a.id))[1] AS client_id
        FROM orders o JOIN client_accounts a ON lower(trim(a.email)) = lower(trim(o.email))
        WHERE o.client_id IS NULL AND o.attribution = 'historique' AND nullif(trim(o.email), '') IS NOT NULL
        GROUP BY o.id HAVING count(*) = 1) u;

  IF v_multiple > 0 THEN
    RAISE EXCEPTION 'REMPLISSAGE_BLOQUE : % commande(s) ont une correspondance ambiguë (plusieurs comptes) — aucune écriture', v_multiple;
  END IF;
  IF v_cand <> a_cand::int OR v_unique <> a_uniq::int OR v_aucune <> a_aucu::int OR v_empreinte <> a_empr THEN
    RAISE EXCEPTION 'REMPLISSAGE_BLOQUE : les données ont changé depuis le rapport (examinées % / attendu %, uniques % / attendu %, sans compte % / attendu %, empreinte % / attendue %) — aucune écriture',
      v_cand, a_cand, v_unique, a_uniq, v_aucune, a_aucu, v_empreinte, a_empr;
  END IF;

  WITH cible AS (
    SELECT o.id AS order_id, (array_agg(a.id))[1] AS client_id
    FROM orders o JOIN client_accounts a ON lower(trim(a.email)) = lower(trim(o.email))
    WHERE o.client_id IS NULL AND o.attribution = 'historique' AND nullif(trim(o.email), '') IS NOT NULL
    GROUP BY o.id
    HAVING count(*) = 1)
  UPDATE orders o SET client_id = cible.client_id FROM cible WHERE o.id = cible.order_id;
  GET DIAGNOSTICS v_lie = ROW_COUNT;

  IF v_lie <> v_unique THEN RAISE EXCEPTION 'REMPLISSAGE_BLOQUE : incohérence (% rattachées pour % correspondances uniques) — transaction annulée', v_lie, v_unique; END IF;
  RAISE NOTICE 'M1 remplissage : % commandes examinées ; % rattachées (correspondance unique) ; % laissées sans compte (aucun compte) ; 0 ambiguë', v_cand, v_lie, v_aucune;
END $$;

COMMIT;
