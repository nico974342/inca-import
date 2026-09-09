-- Point 2 de la demande "commande-fournisseur v2" : le transit n'avait pas
-- de statut "annulé" (une commande fournisseur annulée devait soit rester
-- affichée comme active, soit être supprimée en perdant toute trace), et une
-- réception partielle faisait basculer l'expédition ENTIÈRE en "Réceptionné"
-- (voir src/pages/api/admin/reception/create.ts), perdant le reliquat encore
-- attendu.
--
-- 'annule' rejoint les statuts existants. shipments_status_check est
-- recréée pour l'accepter ; SHIPMENT_ACTIVE_STATUSES (constants.ts) ne la
-- liste pas, donc une expédition annulée sort immédiatement du calcul de
-- réapprovisionnement, exactement comme une réceptionnée.
--
-- shipment_items.received_quantity trace ce qui a déjà été reçu sur CETTE
-- ligne, indépendamment du statut de l'expédition. NULL = rien reçu pour
-- l'instant (comportement inchangé pour les lignes existantes : le reliquat
-- affiché reste égal à la quantité commandée). reception/create.ts est
-- modifié en parallèle pour l'incrémenter au lieu de toujours clore
-- l'expédition entière.

ALTER TABLE shipments DROP CONSTRAINT IF EXISTS shipments_status_check;
ALTER TABLE shipments ADD CONSTRAINT shipments_status_check
  CHECK (status = ANY (ARRAY['commande', 'en_transit', 'arrive_port', 'dedouanement', 'receptionne', 'annule']));

ALTER TABLE shipment_items
  ADD COLUMN IF NOT EXISTS received_quantity INTEGER;

ALTER TABLE shipment_items
  ADD CONSTRAINT shipment_items_received_quantity_check
    CHECK (received_quantity IS NULL OR received_quantity >= 0);
