-- RETOUR ARRIÈRE CIBLÉ de supabase/regularisation/achats_fa1_cumul.sql : remet à NULL le cumul reçu des 11 lignes de FA/1, et RIEN d'autre. NON APPLIQUÉ en production.
-- Ne touche ni au stock, ni aux réceptions, ni aux marges, ni à aucune autre commande. Refusé (tout annulé) si le nouveau parcours a déjà enregistré une réception sur FA/1
-- (dans ce cas, annuler d'abord cette réception par le parcours prévu : le cumul n'est plus celui de la régularisation) ou si une ligne ne vaut plus la valeur régularisée.
BEGIN;
CREATE TEMP TABLE _fa1_retour (ligne_id uuid PRIMARY KEY, recu int NOT NULL) ON COMMIT DROP;
INSERT INTO _fa1_retour VALUES
  ('6476f9a2-1030-4ae8-88a4-1c6f10667930', 70), ('87bbb39b-00d2-4496-8c50-b0d7055e3ca4', 55), ('ca931c0e-e09a-4b00-bb5c-f3c18369f039', 20), ('ffb56ca5-5507-4aab-a4e7-1ef1548d4918', 25),
  ('06fc8d94-e9e7-42c5-99f7-9971dedd288f', 35), ('df150a71-cc8a-49b9-8e21-a9c773afebbf', 35), ('38466ddb-cf62-4f7d-b943-fbc7496d0ef3', 40), ('de9ba87c-0965-4c62-8cae-45ef6ee33c80', 40),
  ('53476a26-4c22-427d-9615-d910cf296aa2', 30), ('4e5e2d98-12e9-43cc-8e14-00f35dc4a1c3', 20), ('e783ea08-4ac5-46fa-aecb-8a5771af39fe', 13);
DO $$
DECLARE v_ship constant uuid := '2f1712b0-dff2-416d-b2e1-8293061af20b';
BEGIN
  IF EXISTS (SELECT 1 FROM stock_receptions WHERE shipment_id = v_ship) THEN RAISE EXCEPTION 'RECEPTION_RATTACHEE : une réception de commande existe sur FA/1 : retour arrière refusé'; END IF;
  IF (SELECT count(*) FROM shipment_items i JOIN _fa1_retour r ON r.ligne_id = i.id AND i.shipment_id = v_ship AND i.received_quantity = r.recu) <> 11
     OR EXISTS (SELECT 1 FROM shipment_items i WHERE i.shipment_id = v_ship AND i.received_quantity IS NOT NULL AND i.id NOT IN (SELECT ligne_id FROM _fa1_retour)) THEN
    RAISE EXCEPTION 'CUMULS_DIFFERENTS : les cumuls de FA/1 ne sont plus ceux de la régularisation : retour arrière refusé'; END IF;
END $$;
SELECT set_config('inca.achats_ecriture', '1', true);
UPDATE shipment_items i SET received_quantity = NULL FROM _fa1_retour r WHERE r.ligne_id = i.id;
INSERT INTO admin_audit_logs (admin_email, action, target_type, target_id, target_label, details)
VALUES ('retour arrière régularisation FA/1 (script validé)', 'reception.regularisation_cumul_retour', 'shipment', '2f1712b0-dff2-416d-b2e1-8293061af20b', 'FA/1', '{"motif":"retour arrière du rattachement du cumul, sans mouvement de stock"}'::jsonb);
SELECT set_config('inca.achats_ecriture', '', true);
DO $$ BEGIN
  IF (shipment_reception_etat('2f1712b0-dff2-416d-b2e1-8293061af20b')->>'cumul')::int <> 0 THEN RAISE EXCEPTION 'RETOUR_INCOMPLET : le cumul de FA/1 doit être revenu à 0'; END IF;
END $$;
COMMIT;
