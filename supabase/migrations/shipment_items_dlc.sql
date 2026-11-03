-- DLC prévisionnelle saisie sur une expédition en transit.
--
-- À la création d'une expédition on a la facture fournisseur et on connaît
-- souvent les DLC : on les saisit là, et elles pré-remplissent la réception
-- (/admin/reception/new?shipment=…) au lieu d'être ressaisies à l'arrivée.
--
-- C'est une information PRÉVISIONNELLE, comme le reste du transit (voir
-- shipments_table.sql) : elle ne modifie ni le stock, ni le PUMP, et ne
-- déclenche aucune alerte. Les alertes DLC (dlc_lots.sql) ne lisent que
-- stock_reception_items — le stock réel. La DLC qui compte est celle saisie
-- (et éventuellement corrigée) à la réception.
--
-- À LANCER AVANT de déployer le code correspondant.
-- Aucun changement de comportement à la migration : colonne NULL partout.

ALTER TABLE shipment_items
  ADD COLUMN IF NOT EXISTS dlc date;
