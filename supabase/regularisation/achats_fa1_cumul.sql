-- RÉGULARISATION DU CUMUL REÇU DE LA COMMANDE FA/1 (SDR) — SANS MOUVEMENT DE STOCK. NON APPLIQUÉ en production.
-- Ce fichier n'est PAS une migration : il vit hors de supabase/migrations pour ne jamais être rejoué par erreur. Étape 6b de la procédure (docs/achats-procedure-finale-mise-en-production.md).
-- À n'exécuter qu'APRÈS la migration achats_receptions_partielles.sql, AVANT l'activation, avec un accord écrit explicite, une seule fois.
--
-- Principe : les réceptions saisies par l'ancien parcours ont DÉJÀ mis le stock à jour. On enregistre seulement, ligne par ligne, la quantité de FA/1 qu'elles représentent
-- (shipment_items.received_quantity), pour que le nouveau parcours ne les reçoive pas une seconde fois. Aucune écriture dans products, stock_receptions, stock_reception_items, cump_*, orders.
-- Règles de rapprochement (docs/achats-fa1-rapprochement.md) : milkshakes du 24/08 non rattachés ; 10 coconut du 16/09 hors FA/1 ; Triple Vanille ≠ Triple Chocolate.
-- Résultat attendu : 383 cartons reçus, 207 restants, 11 lignes renseignées (soldées sauf Triple Chocolate 13/20), 5 lignes inchangées (NULL).
-- Toute anomalie lève une exception : la transaction est ANNULÉE EN ENTIER, rien n'est écrit.
BEGIN;

CREATE TEMP TABLE _fa1 (ligne_id uuid PRIMARY KEY, product_id uuid NOT NULL, commande int NOT NULL, recu int) ON COMMIT DROP;
INSERT INTO _fa1 (ligne_id, product_id, commande, recu) VALUES
  ('610602d3-4e16-488b-9c3d-5c497226303e', 'bafc2eca-5cbd-44bb-a595-11b73eaa0c2c', 20, NULL),   -- Maxx Circus Melon & Gooseberry : rien reçu
  ('041f8e65-cfc0-4f01-8b11-25dc75623e5e', 'd99e79a6-6b37-45ce-88e9-d406d13fb3b1', 20, NULL),   -- Maxx Circus Pinneberry & Guava : rien reçu
  ('f65e1d30-70c9-4ef8-82db-26bfa870106c', 'c8740f1a-5e9d-4dfa-b61c-84f2ef7e2505', 60, NULL),   -- Milkshake Banane : 60 du 24/08 NON rattachés
  ('32855185-9209-49ce-8b56-97a6fa3c3588', 'ad7a7da4-f831-47c3-8c23-d61f2848c4a1', 60, NULL),   -- Milkshake Café : 60 du 24/08 NON rattachés
  ('6476f9a2-1030-4ae8-88a4-1c6f10667930', '708a48a1-7176-40eb-967c-6796b1593ca1', 70, 70),     -- Milkshake Chocolat : 8 (16/09) + 62 (10/11)
  ('6863aaac-918d-46ac-ac71-ae73430a4aa1', 'f103bada-3636-4614-9d0d-c3e4815fc548', 40, NULL),   -- Milkshake Fraise : 40 du 24/08 NON rattachés
  ('87bbb39b-00d2-4496-8c50-b0d7055e3ca4', 'd4059fef-b73d-4e26-a439-7aa73ef435c5', 55, 55),     -- Milkshake Vanille Extra Crémeux : 55 (10/11)
  ('ca931c0e-e09a-4b00-bb5c-f3c18369f039', 'a709f71d-33fb-46f5-a4aa-f055ad4bc27f', 20, 20),     -- Barre Active Coconut : 20 (10/11) ; les 10 du 16/09 = autre commande
  ('ffb56ca5-5507-4aab-a4e7-1ef1548d4918', '77a3eb4d-afed-4ea1-9ef8-723d0d08c751', 25, 25),     -- Barre Delight Cookies & cream : 25 (16/09)
  ('06fc8d94-e9e7-42c5-99f7-9971dedd288f', 'ba5bbc20-5ce6-4a31-9fe6-cd079fc98096', 35, 35),     -- Barre Delight Crunchy Brownie : 35 (16/09)
  ('df150a71-cc8a-49b9-8e21-a9c773afebbf', '860c3d41-68f7-44a6-8c87-31eac0464b2f', 35, 35),     -- Barre Lo Carb Stracciatella : 21 + 14
  ('38466ddb-cf62-4f7d-b943-fbc7496d0ef3', 'bb9a7efc-20b4-44ce-a6fe-0be0715a9d45', 40, 40),     -- Barre Maxx Choco Mousse : 14 + 26
  ('de9ba87c-0965-4c62-8cae-45ef6ee33c80', '2697d4c7-a01e-4958-bebe-d3134911fd5a', 40, 40),     -- Barre Maxx Cookies and Cream : 3 + 37
  ('53476a26-4c22-427d-9615-d910cf296aa2', 'e47c7bdc-802e-49f1-af69-6312c5b3fcff', 30, 30),     -- Barre Power Dubai Chocolate : 30 (16/09)
  ('4e5e2d98-12e9-43cc-8e14-00f35dc4a1c3', '4419cba5-75f6-4869-843a-e786257471af', 20, 20),     -- Barre Power Crunchy Choco : 20 (16/09)
  ('e783ea08-4ac5-46fa-aecb-8a5771af39fe', '46a38a89-15b2-4b0e-94cb-42da5ab64561', 20, 13);     -- Cookie Triple Chocolate : 5 + 8 ; les 7 Triple Vanille ne comptent pas

-- 1) Garde-fous AVANT toute écriture
DO $$
DECLARE v_ship constant uuid := '2f1712b0-dff2-416d-b2e1-8293061af20b'; n int;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'stock_receptions' AND column_name = 'shipment_id') THEN
    RAISE EXCEPTION 'MIGRATION_ABSENTE : appliquer d''abord achats_receptions_partielles.sql'; END IF;
  IF NOT EXISTS (SELECT 1 FROM shipments WHERE id = v_ship AND reference = 'FA/1' AND supplier_name = 'SDR' AND status = 'commande') THEN
    RAISE EXCEPTION 'COMMANDE_INATTENDUE : FA/1 (SDR, statut « commande ») introuvable ou modifiée'; END IF;
  SELECT count(*) INTO n FROM shipment_items i WHERE i.shipment_id = v_ship;
  IF n <> 16 OR EXISTS (SELECT 1 FROM shipment_items i WHERE i.shipment_id = v_ship AND NOT EXISTS (SELECT 1 FROM _fa1 f WHERE f.ligne_id = i.id AND f.product_id = i.product_id AND f.commande = i.quantity)) THEN
    RAISE EXCEPTION 'LIGNES_INATTENDUES : les 16 lignes de FA/1 (identifiants, produits, quantités) ont changé depuis le rapprochement'; END IF;
  IF EXISTS (SELECT 1 FROM shipment_items WHERE shipment_id = v_ship AND received_quantity IS NOT NULL) THEN
    RAISE EXCEPTION 'DEJA_RENSEIGNEE : un cumul existe déjà sur FA/1 (régularisation déjà faite ou réception saisie) : arrêt'; END IF;
  IF EXISTS (SELECT 1 FROM stock_receptions WHERE shipment_id = v_ship) THEN
    RAISE EXCEPTION 'RECEPTION_DEJA_RATTACHEE : le nouveau parcours a déjà enregistré une réception sur FA/1 : arrêt'; END IF;
  IF (SELECT coalesce(sum(recu), 0) FROM _fa1) <> 383 OR EXISTS (SELECT 1 FROM _fa1 WHERE recu IS NOT NULL AND (recu < 1 OR recu > commande)) THEN
    RAISE EXCEPTION 'QUANTITES_INCOHERENTES : le total doit être 383 et chaque ligne comprise entre 1 et la quantité commandée'; END IF;
END $$;

-- 2) Les produits concernés sont verrouillés (lecture partagée, ordre stable) : aucune livraison ni réception ne peut les modifier pendant la vérification « stock inchangé »
SELECT 1 FROM products WHERE id IN (SELECT product_id FROM _fa1) ORDER BY id FOR SHARE;
CREATE TEMP TABLE _fa1_avant ON COMMIT DROP AS
  SELECT (SELECT md5(string_agg(concat_ws('|', id, stock_quantity, coalesce(prix_achat_moyen_ht::text, '-')), ',' ORDER BY id)) FROM products WHERE id IN (SELECT product_id FROM _fa1)) AS produits,
         (SELECT count(*) FROM stock_receptions) AS receptions, (SELECT count(*) FROM stock_reception_items) AS lignes_receptions, (SELECT count(*) FROM cump_file) AS file_cump;

-- 3) Écriture : drapeau local à la transaction (sans lui, la base refuse : CUMUL_PROTEGE)
SELECT set_config('inca.achats_ecriture', '1', true);
UPDATE shipment_items i SET received_quantity = f.recu FROM _fa1 f WHERE f.ligne_id = i.id AND f.recu IS NOT NULL;
INSERT INTO admin_audit_logs (admin_email, action, target_type, target_id, target_label, details)
VALUES ('régularisation FA/1 (script validé)', 'reception.regularisation_cumul', 'shipment', '2f1712b0-dff2-416d-b2e1-8293061af20b', 'FA/1',
        jsonb_build_object('motif', 'rattachement du cumul des réceptions saisies avant le suivi par quantités, sans mouvement de stock',
                           'receptions', jsonb_build_array('24c21a2d-3376-4555-affe-263b784f7e74', '74b9606f-575d-4824-b82d-eadd62040180'),
                           'recu', 383, 'reste', 207, 'non_rattaches', jsonb_build_object('milkshakes_24_08', 160, 'coconut_16_09', 10, 'triple_vanille_10_11', 7),
                           'lignes', (SELECT jsonb_agg(jsonb_build_object('ligne', ligne_id, 'recu', recu) ORDER BY ligne_id) FROM _fa1 WHERE recu IS NOT NULL)));
SELECT set_config('inca.achats_ecriture', '', true);

-- 4) Contrôles APRÈS écriture, dans la même transaction : tout écart annule tout
DO $$
DECLARE v_ship constant uuid := '2f1712b0-dff2-416d-b2e1-8293061af20b'; e jsonb; a record; p text;
BEGIN
  e := shipment_reception_etat(v_ship); SELECT * INTO a FROM _fa1_avant;
  IF (e->>'recu')::int <> 383 OR (e->>'reste')::int <> 207 OR (e->>'cumul')::int <> 383 OR e->>'statut' <> 'partielle' OR (e->>'commande')::int <> 590 THEN
    RAISE EXCEPTION 'ETAT_INATTENDU : % (attendu reçu 383, reste 207, partielle)', e; END IF;
  SELECT md5(string_agg(concat_ws('|', id, stock_quantity, coalesce(prix_achat_moyen_ht::text, '-')), ',' ORDER BY id)) INTO p FROM products WHERE id IN (SELECT product_id FROM _fa1);
  IF p IS DISTINCT FROM a.produits THEN RAISE EXCEPTION 'STOCK_OU_PUMP_MODIFIE : la régularisation ne doit modifier ni stock ni prix d''achat moyen'; END IF;
  IF (SELECT count(*) FROM stock_receptions) <> a.receptions OR (SELECT count(*) FROM stock_reception_items) <> a.lignes_receptions OR (SELECT count(*) FROM cump_file) <> a.file_cump THEN
    RAISE EXCEPTION 'OBJETS_MODIFIES : réceptions, lignes de réception ou file CUMP ont changé'; END IF;
  IF (SELECT count(*) FROM shipment_items WHERE shipment_id = v_ship AND received_quantity IS NOT NULL) <> 11 THEN RAISE EXCEPTION 'LIGNES_RENSEIGNEES : 11 attendues'; END IF;
END $$;

COMMIT;
