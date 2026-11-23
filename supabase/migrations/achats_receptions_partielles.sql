-- Suivi des achats : réceptions PARTIELLES fiables d'une commande fournisseur (expédition).
-- NON APPLIQUÉE en production : à exécuter seulement sur accord explicite, après sauvegarde.
-- ADDITIVE : aucune donnée existante n'est modifiée (colonnes NULL pour l'existant ; aucune ligne supprimée ni réécrite).
-- Indépendante de la TVA, des factures, des prix fournisseurs et de la facturation.
--
-- RÉUTILISE le mécanisme existant : mêmes tables stock_receptions / stock_reception_items, même recalcul du PUMP (recalc_pump), même stock
-- products.stock_quantity, même cumul shipment_items.received_quantity. Aucun second système de mouvements. Tout est exprimé dans la MÊME
-- unité (le carton) : commande, réception et stock. Aucune conversion n'est faite ici.
--
-- Ce que la base garantit (indépendamment de l'interface) :
--   * UNE seule opération atomique, reception_commande_enregistrer : réception + lignes reçues + stock + PUMP + cumul par ligne + rattachement à la
--     commande + nouvel état de réception, dans une seule transaction. Le moindre échec annule tout.
--   * Clé d'idempotence PERSISTÉE : un double clic, un renvoi après coupure réseau ne créent jamais deux réceptions ni deux entrées en stock.
--   * Deux réceptions simultanées de la même commande se SÉRIALISENT (verrous pris dans un ordre fixe : commande, lignes, produits) : la seconde
--     est validée contre le cumul réel, jamais contre un état périmé.
--   * Jamais plus que le reste à recevoir : refus par défaut. La quantité commandée ne change JAMAIS automatiquement ; seul un administrateur la
--     modifie, avec motif et historique (shipment_item_quantite_modifier).
--   * Une réception rattachée à une commande n'est jamais modifiée ni supprimée en silence : annulation motivée par un administrateur
--     (reception_commande_annuler), journalisée, archivée ; le stock n'est régularisé que s'il est encore là (sinon refus, aucune régularisation
--     incohérente automatique).
--   * Le cumul reçu d'une ligne ne se modifie que par ces fonctions.

BEGIN;

-- ── 1. Colonnes (toutes NULL pour l'existant) ────────────────────────────────────────────────────────────────────────────
ALTER TABLE stock_receptions
  ADD COLUMN IF NOT EXISTS shipment_id        uuid,
  ADD COLUMN IF NOT EXISTS cle_idempotence    uuid,
  ADD COLUMN IF NOT EXISTS empreinte          text,
  ADD COLUMN IF NOT EXISTS bl_fournisseur     text,
  ADD COLUMN IF NOT EXISTS created_by         uuid,
  ADD COLUMN IF NOT EXISTS created_by_email   text,
  ADD COLUMN IF NOT EXISTS annulee_le         timestamptz,
  ADD COLUMN IF NOT EXISTS annulee_par        text,
  ADD COLUMN IF NOT EXISTS annulation_motif   text;
ALTER TABLE stock_receptions DROP CONSTRAINT IF EXISTS stock_receptions_shipment_fkey;
ALTER TABLE stock_receptions ADD CONSTRAINT stock_receptions_shipment_fkey FOREIGN KEY (shipment_id) REFERENCES shipments(id) ON DELETE RESTRICT;
ALTER TABLE stock_receptions DROP CONSTRAINT IF EXISTS stock_receptions_commande_complete;
ALTER TABLE stock_receptions ADD CONSTRAINT stock_receptions_commande_complete
  CHECK (shipment_id IS NULL OR (cle_idempotence IS NOT NULL AND created_by IS NOT NULL AND created_by_email IS NOT NULL AND stock_applied));
ALTER TABLE stock_receptions DROP CONSTRAINT IF EXISTS stock_receptions_annulation_coherente;
ALTER TABLE stock_receptions ADD CONSTRAINT stock_receptions_annulation_coherente
  CHECK ((annulee_le IS NULL) = (annulee_par IS NULL) AND (annulee_le IS NULL) = (annulation_motif IS NULL) AND (annulee_le IS NULL OR shipment_id IS NOT NULL));
CREATE UNIQUE INDEX IF NOT EXISTS stock_receptions_cle_idx ON stock_receptions (cle_idempotence) WHERE cle_idempotence IS NOT NULL;
CREATE INDEX IF NOT EXISTS stock_receptions_shipment_idx ON stock_receptions (shipment_id) WHERE shipment_id IS NOT NULL;

ALTER TABLE stock_reception_items ADD COLUMN IF NOT EXISTS shipment_item_id uuid;
ALTER TABLE stock_reception_items DROP CONSTRAINT IF EXISTS stock_reception_items_shipment_item_fkey;
ALTER TABLE stock_reception_items ADD CONSTRAINT stock_reception_items_shipment_item_fkey FOREIGN KEY (shipment_item_id) REFERENCES shipment_items(id) ON DELETE RESTRICT;
CREATE INDEX IF NOT EXISTS stock_reception_items_shipment_item_idx ON stock_reception_items (shipment_item_id) WHERE shipment_item_id IS NOT NULL;

-- Statut logistique avant le passage automatique à « réceptionné » (pour le restaurer si une annulation ou une hausse de quantité rouvre la commande)
ALTER TABLE shipments ADD COLUMN IF NOT EXISTS statut_avant_reception text;

-- ── 2. Archives : rien ne se perd ────────────────────────────────────────────────────────────────────────────────────────
-- Lignes d'une réception ANNULÉE : copiées ici avant d'être retirées du stock_reception_items « actif » (que le PUMP, les lots DLC, l'audit des
-- stocks et les marges relisent). La réception elle-même reste, marquée annulée, avec auteur, date et motif.
CREATE TABLE IF NOT EXISTS stock_reception_items_annulees (
  id               uuid PRIMARY KEY,                                                     -- identifiant d'origine de la ligne
  reception_id     uuid NOT NULL REFERENCES stock_receptions(id) ON DELETE RESTRICT,
  product_id       uuid NOT NULL REFERENCES products(id),
  quantity         integer NOT NULL,
  unit_cost_ht     numeric NOT NULL,
  dlc              date,
  shipment_item_id uuid REFERENCES shipment_items(id) ON DELETE RESTRICT,
  created_at       timestamptz NOT NULL,
  archive_le       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS stock_reception_items_annulees_rec_idx ON stock_reception_items_annulees (reception_id);

-- Historique des changements de quantité COMMANDÉE (réservés à l'administrateur, avec motif)
CREATE TABLE IF NOT EXISTS shipment_item_quantites_historique (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shipment_item_id uuid NOT NULL REFERENCES shipment_items(id) ON DELETE RESTRICT,
  shipment_id      uuid NOT NULL,
  product_id       uuid NOT NULL,
  ancienne         integer NOT NULL,
  nouvelle         integer NOT NULL,
  motif            text NOT NULL,
  par_id           uuid NOT NULL,
  par_email        text NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT shipment_item_quantites_motif CHECK (length(btrim(motif)) >= 3)
);
CREATE INDEX IF NOT EXISTS shipment_item_quantites_hist_idx ON shipment_item_quantites_historique (shipment_id, created_at);

ALTER TABLE stock_reception_items_annulees       ENABLE ROW LEVEL SECURITY;
ALTER TABLE shipment_item_quantites_historique   ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON stock_reception_items_annulees, shipment_item_quantites_historique FROM anon, authenticated;
REVOKE DELETE, TRUNCATE, REFERENCES, TRIGGER ON stock_reception_items_annulees, shipment_item_quantites_historique FROM service_role;   -- jamais de suppression

-- ── 3. Calcul des quantités et de l'état de réception (une seule définition, utilisée par la base ET par les tests de l'écran) ───
-- Quantités PURES : commandé, reçu, reste, cumul, soldé. Aucune dépendance au statut logistique.
CREATE OR REPLACE FUNCTION shipment_reception_quantites(p_shipment_id uuid) RETURNS jsonb
LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT jsonb_build_object(
    'lignes',   count(*)::int,
    'commande', coalesce(sum(quantity), 0)::int,
    'recu',     coalesce(sum(least(coalesce(received_quantity, 0), quantity)), 0)::int,
    'reste',    coalesce(sum(greatest(quantity - coalesce(received_quantity, 0), 0)), 0)::int,
    'cumul',    coalesce(sum(coalesce(received_quantity, 0)), 0)::int,
    'solde',    count(*) > 0 AND bool_and(coalesce(received_quantity, 0) >= quantity))
  FROM shipment_items WHERE shipment_id = p_shipment_id $$;

-- État de réception : attente (rien reçu) / partielle / integrale. Indépendant du statut logistique, SAUF pour les commandes clôturées « Réceptionné »
-- avant le suivi par quantités (historique = true) : leur stock a déjà été compté, elles restent « intégrale » et ne peuvent plus être réceptionnées.
CREATE OR REPLACE FUNCTION shipment_reception_etat(p_shipment_id uuid) RETURNS jsonb
LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT q.j || jsonb_build_object(
    'statut', CASE WHEN (q.j->>'solde')::boolean THEN 'integrale'
                   WHEN s.status = 'receptionne' AND (q.j->>'lignes')::int > 0 THEN 'integrale'
                   WHEN (q.j->>'cumul')::int = 0 THEN 'attente'
                   ELSE 'partielle' END,
    'historique', (s.status = 'receptionne' AND NOT (q.j->>'solde')::boolean AND (q.j->>'lignes')::int > 0),
    'receptions', (SELECT count(*) FROM stock_receptions WHERE shipment_id = p_shipment_id AND annulee_le IS NULL)::int)
  FROM shipments s, (SELECT shipment_reception_quantites(p_shipment_id) AS j) q
  WHERE s.id = p_shipment_id $$;

-- ── 4. Protections (déclencheurs) ────────────────────────────────────────────────────────────────────────────────────────

-- Lignes de commande : le cumul reçu ne se modifie que par les fonctions ci-dessous ; une ligne qui a reçu quelque chose ne se supprime pas et sa
-- quantité commandée ne change que par la modification JUSTIFIÉE ; jamais un cumul supérieur à la quantité commandée.
CREATE OR REPLACE FUNCTION shipment_items_proteger() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE v_flag boolean := coalesce(current_setting('inca.achats_ecriture', true), '') = '1'; v_recue boolean;
BEGIN
  IF TG_OP = 'TRUNCATE' THEN RAISE EXCEPTION 'LIGNE_RECUE_NON_SUPPRIMABLE : les lignes de commande ne se vident pas'; END IF;
  IF TG_OP = 'DELETE' THEN
    IF coalesce(OLD.received_quantity, 0) > 0 OR EXISTS (SELECT 1 FROM stock_reception_items WHERE shipment_item_id = OLD.id)
       OR EXISTS (SELECT 1 FROM stock_reception_items_annulees WHERE shipment_item_id = OLD.id) THEN
      RAISE EXCEPTION 'LIGNE_RECUE_NON_SUPPRIMABLE : cette ligne a déjà reçu de la marchandise (historique à conserver)';
    END IF;
    RETURN OLD;
  END IF;
  v_recue := coalesce(OLD.received_quantity, 0) > 0 OR EXISTS (SELECT 1 FROM stock_reception_items WHERE shipment_item_id = OLD.id);
  IF NEW.received_quantity IS DISTINCT FROM OLD.received_quantity AND NOT v_flag THEN
    RAISE EXCEPTION 'CUMUL_PROTEGE : le cumul reçu ne se modifie que par l''enregistrement ou l''annulation d''une réception (tracés)';
  END IF;
  IF (NEW.shipment_id, NEW.product_id) IS DISTINCT FROM (OLD.shipment_id, OLD.product_id) AND v_recue THEN
    RAISE EXCEPTION 'LIGNE_RECUE_IMMUABLE : produit et commande d''une ligne déjà reçue ne changent pas';
  END IF;
  IF NEW.quantity IS DISTINCT FROM OLD.quantity AND v_recue AND NOT v_flag THEN
    RAISE EXCEPTION 'QUANTITE_PROTEGEE : la quantité commandée d''une ligne déjà reçue ne se modifie que par la modification justifiée (administrateur, motif, historique)';
  END IF;
  IF coalesce(NEW.received_quantity, 0) > NEW.quantity AND (NEW.received_quantity IS DISTINCT FROM OLD.received_quantity OR NEW.quantity IS DISTINCT FROM OLD.quantity) THEN
    RAISE EXCEPTION 'CUMUL_SUPERIEUR_COMMANDE : le cumul reçu ne peut pas dépasser la quantité commandée';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_shipment_items_proteger ON shipment_items;
CREATE TRIGGER trg_shipment_items_proteger BEFORE UPDATE OR DELETE ON shipment_items FOR EACH ROW EXECUTE FUNCTION shipment_items_proteger();
DROP TRIGGER IF EXISTS trg_shipment_items_proteger_truncate ON shipment_items;
CREATE TRIGGER trg_shipment_items_proteger_truncate BEFORE TRUNCATE ON shipment_items FOR EACH STATEMENT EXECUTE FUNCTION shipment_items_proteger();

-- Commande : une commande qui a reçu de la marchandise ne se supprime pas (la suppression d'une commande jamais reçue reste possible, comme avant)
CREATE OR REPLACE FUNCTION shipments_proteger() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM shipment_items WHERE shipment_id = OLD.id AND coalesce(received_quantity, 0) > 0)
     OR EXISTS (SELECT 1 FROM stock_receptions WHERE shipment_id = OLD.id) THEN
    RAISE EXCEPTION 'COMMANDE_RECUE_NON_SUPPRIMABLE : cette commande a des réceptions (historique à conserver) ; passez-la au statut annulé';
  END IF;
  RETURN OLD;
END $$;
DROP TRIGGER IF EXISTS trg_shipments_proteger ON shipments;
CREATE TRIGGER trg_shipments_proteger BEFORE DELETE ON shipments FOR EACH ROW EXECUTE FUNCTION shipments_proteger();

-- Réceptions : une réception rattachée à une commande n'est jamais supprimée ni modifiée à la main (seul supplier_id, rapprochement fournisseur,
-- reste permis). Les réceptions historiques (non rattachées) gardent leur comportement d'origine. Aucune réception ne se vide par TRUNCATE.
CREATE OR REPLACE FUNCTION stock_receptions_proteger() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE v_flag boolean := coalesce(current_setting('inca.achats_ecriture', true), '') = '1';
BEGIN
  IF TG_OP = 'TRUNCATE' THEN RAISE EXCEPTION 'RECEPTION_NON_SUPPRIMABLE : les réceptions ne se vident pas'; END IF;
  IF TG_OP = 'DELETE' THEN
    IF OLD.shipment_id IS NOT NULL THEN RAISE EXCEPTION 'RECEPTION_LIEE_COMMANDE : une réception rattachée à une commande ne se supprime pas (annulation motivée par un administrateur)'; END IF;
    RETURN OLD;
  END IF;
  IF OLD.shipment_id IS NULL AND NEW.shipment_id IS NULL AND OLD.cle_idempotence IS NULL AND NEW.cle_idempotence IS NULL AND OLD.annulee_le IS NULL AND NEW.annulee_le IS NULL THEN
    RETURN NEW;                                                                                          -- réception historique : comportement inchangé
  END IF;
  IF v_flag THEN
    IF (NEW.id, NEW.shipment_id, NEW.cle_idempotence, NEW.created_by, NEW.created_at, NEW.received_at, NEW.supplier_name, NEW.bl_fournisseur, NEW.notes, NEW.empreinte)
       IS DISTINCT FROM (OLD.id, OLD.shipment_id, OLD.cle_idempotence, OLD.created_by, OLD.created_at, OLD.received_at, OLD.supplier_name, OLD.bl_fournisseur, OLD.notes, OLD.empreinte) THEN
      RAISE EXCEPTION 'RECEPTION_IMMUABLE : date, fournisseur, BL, commentaire, auteur et commande d''une réception ne changent jamais';
    END IF;
    RETURN NEW;
  END IF;
  IF (to_jsonb(NEW) - 'supplier_id') IS DISTINCT FROM (to_jsonb(OLD) - 'supplier_id') THEN
    RAISE EXCEPTION 'RECEPTION_LIEE_COMMANDE : une réception rattachée à une commande ne se modifie pas (annulation motivée par un administrateur)';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_stock_receptions_proteger ON stock_receptions;
CREATE TRIGGER trg_stock_receptions_proteger BEFORE UPDATE OR DELETE ON stock_receptions FOR EACH ROW EXECUTE FUNCTION stock_receptions_proteger();
DROP TRIGGER IF EXISTS trg_stock_receptions_proteger_truncate ON stock_receptions;
CREATE TRIGGER trg_stock_receptions_proteger_truncate BEFORE TRUNCATE ON stock_receptions FOR EACH STATEMENT EXECUTE FUNCTION stock_receptions_proteger();

-- Lignes de réception : celles d'une réception rattachée à une commande ne s'ajoutent, ne se modifient et ne se retirent que par les fonctions
CREATE OR REPLACE FUNCTION stock_reception_items_proteger() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE v_flag boolean := coalesce(current_setting('inca.achats_ecriture', true), '') = '1'; v_rec uuid;
BEGIN
  IF TG_OP = 'TRUNCATE' THEN RAISE EXCEPTION 'RECEPTION_NON_SUPPRIMABLE : les lignes de réception ne se vident pas'; END IF;
  IF v_flag THEN RETURN coalesce(NEW, OLD); END IF;
  v_rec := coalesce(NEW.reception_id, OLD.reception_id);
  IF EXISTS (SELECT 1 FROM stock_receptions WHERE id = v_rec AND shipment_id IS NOT NULL) THEN
    RAISE EXCEPTION 'RECEPTION_LIEE_COMMANDE : les quantités d''une réception rattachée à une commande ne se modifient pas (annulation motivée par un administrateur)';
  END IF;
  IF TG_OP IN ('INSERT', 'UPDATE') AND NEW.shipment_item_id IS NOT NULL THEN
    RAISE EXCEPTION 'RECEPTION_LIEE_COMMANDE : une ligne ne se rattache à une commande que par l''enregistrement d''une réception de commande';
  END IF;
  RETURN coalesce(NEW, OLD);
END $$;
DROP TRIGGER IF EXISTS trg_stock_reception_items_proteger ON stock_reception_items;
CREATE TRIGGER trg_stock_reception_items_proteger BEFORE INSERT OR UPDATE OR DELETE ON stock_reception_items FOR EACH ROW EXECUTE FUNCTION stock_reception_items_proteger();
DROP TRIGGER IF EXISTS trg_stock_reception_items_proteger_truncate ON stock_reception_items;
CREATE TRIGGER trg_stock_reception_items_proteger_truncate BEFORE TRUNCATE ON stock_reception_items FOR EACH STATEMENT EXECUTE FUNCTION stock_reception_items_proteger();

-- Archives et historiques : jamais modifiés ni supprimés
CREATE OR REPLACE FUNCTION achats_historique_proteger() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN RAISE EXCEPTION 'HISTORIQUE_IMMUABLE : archives et historiques de réception ne se modifient ni ne se suppriment'; END $$;
DROP TRIGGER IF EXISTS trg_stock_reception_items_annulees_proteger ON stock_reception_items_annulees;
CREATE TRIGGER trg_stock_reception_items_annulees_proteger BEFORE UPDATE OR DELETE ON stock_reception_items_annulees FOR EACH ROW EXECUTE FUNCTION achats_historique_proteger();
DROP TRIGGER IF EXISTS trg_stock_reception_items_annulees_proteger_truncate ON stock_reception_items_annulees;
CREATE TRIGGER trg_stock_reception_items_annulees_proteger_truncate BEFORE TRUNCATE ON stock_reception_items_annulees FOR EACH STATEMENT EXECUTE FUNCTION achats_historique_proteger();
DROP TRIGGER IF EXISTS trg_shipment_item_quantites_proteger ON shipment_item_quantites_historique;
CREATE TRIGGER trg_shipment_item_quantites_proteger BEFORE UPDATE OR DELETE ON shipment_item_quantites_historique FOR EACH ROW EXECUTE FUNCTION achats_historique_proteger();
DROP TRIGGER IF EXISTS trg_shipment_item_quantites_proteger_truncate ON shipment_item_quantites_historique;
CREATE TRIGGER trg_shipment_item_quantites_proteger_truncate BEFORE TRUNCATE ON shipment_item_quantites_historique FOR EACH STATEMENT EXECUTE FUNCTION achats_historique_proteger();

-- ── 5. Enregistrer une réception de commande : UNE transaction ──────────────────────────────────────────────────────────
-- p_items : [{ "shipment_item_id": uuid, "quantity": entier >= 0, "unit_cost_ht": nombre >= 0 (obligatoire si quantity > 0), "dlc": "AAAA-MM-JJ" | null }, …]
-- Les lignes à 0 sont acceptées et ignorées (un fournisseur qui ne livre pas tout). Au moins une ligne > 0.
CREATE OR REPLACE FUNCTION reception_commande_enregistrer(
  p_cle uuid, p_shipment_id uuid, p_received_at date, p_bl text, p_notes text, p_items jsonb,
  p_acteur_id uuid, p_acteur_email text, p_acteur_role text
) RETURNS jsonb
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE
  s shipments%ROWTYPE; r stock_receptions%ROWTYPE; l shipment_items%ROWTYPE; it jsonb;
  v_bl text := nullif(btrim(coalesce(p_bl, '')), ''); v_notes text := nullif(btrim(coalesce(p_notes, '')), '');
  v_aujourdhui date := ((now() AT TIME ZONE 'UTC') + interval '4 hours')::date;
  v_lignes jsonb := '[]'::jsonb; v_item uuid; v_q int; v_cout numeric; v_dlc date; v_reste int; v_vus uuid[] := '{}';
  v_empreinte text; v_id uuid; v_pids uuid[]; v_etat jsonb; v_quant jsonb; v_nb_prod int; v_maj int;
BEGIN
  IF p_acteur_role IS DISTINCT FROM 'admin' OR p_acteur_id IS NULL OR nullif(btrim(coalesce(p_acteur_email, '')), '') IS NULL THEN RAISE EXCEPTION 'ACTION_INTERDITE'; END IF;
  IF p_cle IS NULL THEN RAISE EXCEPTION 'CLE_REQUISE'; END IF;
  IF p_items IS NULL OR jsonb_typeof(p_items) <> 'array' OR jsonb_array_length(p_items) = 0 OR jsonb_array_length(p_items) > 500 THEN RAISE EXCEPTION 'LIGNES_REQUISES'; END IF;

  -- 1) verrou de la commande EN PREMIER : deux réceptions simultanées de la même commande se sérialisent ici
  SELECT * INTO s FROM shipments WHERE id = p_shipment_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'COMMANDE_INTROUVABLE'; END IF;

  v_empreinte := md5(p_shipment_id::text || '|' || coalesce(p_received_at::text, '') || '|' || coalesce(v_bl, '') || '|' || p_items::text);

  -- 2) rejeu (double clic, renvoi après coupure réseau) : on renvoie la réception déjà enregistrée, sans rien ré-appliquer
  SELECT * INTO r FROM stock_receptions WHERE cle_idempotence = p_cle;
  IF FOUND THEN
    IF r.shipment_id IS DISTINCT FROM p_shipment_id OR r.created_by IS DISTINCT FROM p_acteur_id THEN RAISE EXCEPTION 'CLE_DEJA_UTILISEE'; END IF;
    IF r.empreinte IS DISTINCT FROM v_empreinte THEN RAISE EXCEPTION 'CLE_REUTILISEE_AUTRES_DONNEES'; END IF;
    RETURN jsonb_build_object('reception_id', r.id, 'deja', true, 'etat', shipment_reception_etat(p_shipment_id));
  END IF;

  IF s.status = 'annule' THEN RAISE EXCEPTION 'COMMANDE_ANNULEE'; END IF;
  IF shipment_reception_etat(p_shipment_id)->>'statut' = 'integrale' THEN RAISE EXCEPTION 'COMMANDE_DEJA_SOLDEE'; END IF;
  IF p_received_at IS NULL OR p_received_at > v_aujourdhui OR p_received_at < v_aujourdhui - 1100 THEN RAISE EXCEPTION 'DATE_INVALIDE'; END IF;
  IF length(coalesce(v_bl, '')) > 120 OR length(coalesce(v_notes, '')) > 500 THEN RAISE EXCEPTION 'TEXTE_TROP_LONG'; END IF;

  -- 3) verrou des lignes (ordre stable), puis validation de CHAQUE ligne contre le cumul réel
  PERFORM 1 FROM shipment_items WHERE shipment_id = p_shipment_id ORDER BY id FOR UPDATE;
  FOR it IN SELECT * FROM jsonb_array_elements(p_items) LOOP
    IF jsonb_typeof(it) <> 'object' OR coalesce(it->>'shipment_item_id', '') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN RAISE EXCEPTION 'LIGNE_INCONNUE'; END IF;
    v_item := (it->>'shipment_item_id')::uuid;
    SELECT * INTO l FROM shipment_items WHERE id = v_item AND shipment_id = p_shipment_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'LIGNE_INCONNUE'; END IF;
    IF v_item = ANY (v_vus) THEN RAISE EXCEPTION 'LIGNE_EN_DOUBLE'; END IF;
    v_vus := v_vus || v_item;
    IF jsonb_typeof(it->'quantity') IS DISTINCT FROM 'number' OR (it->>'quantity') !~ '^[0-9]{1,7}$' THEN RAISE EXCEPTION 'QUANTITE_INVALIDE'; END IF;
    v_q := (it->>'quantity')::int;
    IF v_q = 0 THEN CONTINUE; END IF;                                                                   -- ligne non livrée : ignorée
    v_reste := l.quantity - coalesce(l.received_quantity, 0);
    IF v_q > v_reste THEN
      RAISE EXCEPTION 'DEPASSEMENT_COMMANDE : % demandé(s) pour % restant(s) à recevoir (commandé %, déjà reçu %)', v_q, greatest(v_reste, 0), l.quantity, coalesce(l.received_quantity, 0);
    END IF;
    IF jsonb_typeof(it->'unit_cost_ht') IS DISTINCT FROM 'number' OR (it->>'unit_cost_ht') !~ '^[0-9]{1,9}(\.[0-9]{1,6})?$' THEN RAISE EXCEPTION 'COUT_INVALIDE'; END IF;
    v_cout := (it->>'unit_cost_ht')::numeric;
    v_dlc := NULL;
    IF nullif(it->>'dlc', '') IS NOT NULL THEN
      IF (it->>'dlc') !~ '^\d{4}-\d{2}-\d{2}$' THEN RAISE EXCEPTION 'DLC_INVALIDE'; END IF;
      BEGIN v_dlc := (it->>'dlc')::date; EXCEPTION WHEN others THEN RAISE EXCEPTION 'DLC_INVALIDE'; END;
    END IF;
    v_lignes := v_lignes || jsonb_build_array(jsonb_build_object('shipment_item_id', v_item, 'product_id', l.product_id, 'quantity', v_q, 'unit_cost_ht', v_cout, 'dlc', v_dlc));
  END LOOP;
  IF jsonb_array_length(v_lignes) = 0 THEN RAISE EXCEPTION 'AUCUNE_QUANTITE'; END IF;

  -- 4) produits verrouillés dans l'ordre (aucun interblocage entre commandes qui partagent un produit)
  v_pids := ARRAY(SELECT DISTINCT (x->>'product_id')::uuid FROM jsonb_array_elements(v_lignes) x ORDER BY 1);
  PERFORM 1 FROM products WHERE id = ANY (v_pids) ORDER BY id FOR UPDATE;
  SELECT count(*) INTO v_nb_prod FROM products WHERE id = ANY (v_pids);
  IF v_nb_prod <> coalesce(array_length(v_pids, 1), 0) THEN RAISE EXCEPTION 'PRODUIT_INTROUVABLE'; END IF;

  -- 5) écriture : tout ou rien
  PERFORM set_config('inca.achats_ecriture', '1', true);
  INSERT INTO stock_receptions (supplier_name, supplier_id, received_at, notes, stock_applied, shipment_id, cle_idempotence, empreinte, bl_fournisseur, created_by, created_by_email)
  VALUES (s.supplier_name, s.supplier_id, p_received_at, v_notes, true, p_shipment_id, p_cle, v_empreinte, v_bl, p_acteur_id, p_acteur_email)
  RETURNING id INTO v_id;
  INSERT INTO stock_reception_items (reception_id, product_id, quantity, unit_cost_ht, dlc, shipment_item_id)
  SELECT v_id, (x->>'product_id')::uuid, (x->>'quantity')::int, (x->>'unit_cost_ht')::numeric, NULLIF(x->>'dlc', '')::date, (x->>'shipment_item_id')::uuid
  FROM jsonb_array_elements(v_lignes) x;
  PERFORM recalc_pump(v_pids);
  UPDATE products p SET stock_quantity = p.stock_quantity + a.q, in_stock = (p.stock_quantity + a.q) > 0
  FROM (SELECT (x->>'product_id')::uuid AS pid, sum((x->>'quantity')::int)::int AS q FROM jsonb_array_elements(v_lignes) x GROUP BY 1) a
  WHERE p.id = a.pid;
  UPDATE shipment_items i SET received_quantity = coalesce(i.received_quantity, 0) + a.q
  FROM (SELECT (x->>'shipment_item_id')::uuid AS id, (x->>'quantity')::int AS q FROM jsonb_array_elements(v_lignes) x) a
  WHERE i.id = a.id;
  GET DIAGNOSTICS v_maj = ROW_COUNT;
  IF v_maj <> jsonb_array_length(v_lignes) THEN RAISE EXCEPTION 'CUMUL_INCOHERENT'; END IF;

  -- 6) nouvel état ; la commande passe « réceptionné » (logistique) seulement quand TOUT est reçu, jamais avant
  v_quant := shipment_reception_quantites(p_shipment_id);
  IF (v_quant->>'solde')::boolean AND s.status <> 'receptionne' THEN
    UPDATE shipments SET statut_avant_reception = s.status, status = 'receptionne' WHERE id = p_shipment_id;
  END IF;
  v_etat := shipment_reception_etat(p_shipment_id);
  INSERT INTO admin_audit_logs (admin_email, action, target_type, target_id, target_label, details)
  VALUES (p_acteur_email, 'reception.commande', 'shipment', p_shipment_id::text, coalesce(s.reference, s.supplier_name),
          jsonb_build_object('reception_id', v_id, 'received_at', p_received_at, 'bl', v_bl, 'lignes', v_lignes, 'etat', v_etat));
  PERFORM set_config('inca.achats_ecriture', '', true);
  RETURN jsonb_build_object('reception_id', v_id, 'deja', false, 'etat', v_etat);
END $$;

-- ── 6. Annuler une réception de commande (correction) : administrateur, motif, archivage, stock régularisé SEULEMENT s'il est encore là ─
CREATE OR REPLACE FUNCTION reception_commande_annuler(p_reception_id uuid, p_motif text, p_acteur_id uuid, p_acteur_email text, p_acteur_role text) RETURNS jsonb
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE
  r stock_receptions%ROWTYPE; s shipments%ROWTYPE; x record; v_ship uuid; v_pids uuid[]; v_maj int; v_attendu int; v_etat jsonb; v_quant jsonb;
  v_motif text := nullif(btrim(coalesce(p_motif, '')), ''); v_lignes jsonb;
BEGIN
  IF p_acteur_role IS DISTINCT FROM 'admin' OR p_acteur_id IS NULL OR nullif(btrim(coalesce(p_acteur_email, '')), '') IS NULL THEN RAISE EXCEPTION 'ACTION_INTERDITE'; END IF;
  IF v_motif IS NULL OR length(v_motif) < 3 THEN RAISE EXCEPTION 'MOTIF_REQUIS'; END IF;
  SELECT shipment_id INTO v_ship FROM stock_receptions WHERE id = p_reception_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'RECEPTION_INTROUVABLE'; END IF;
  IF v_ship IS NULL THEN RAISE EXCEPTION 'RECEPTION_NON_LIEE : réception historique (hors commande) : utiliser la correction des réceptions existantes'; END IF;
  SELECT * INTO s FROM shipments WHERE id = v_ship FOR UPDATE;                                          -- même ordre de verrous que l'enregistrement
  SELECT * INTO r FROM stock_receptions WHERE id = p_reception_id FOR UPDATE;
  IF r.annulee_le IS NOT NULL THEN RAISE EXCEPTION 'RECEPTION_DEJA_ANNULEE'; END IF;
  PERFORM 1 FROM shipment_items WHERE shipment_id = v_ship ORDER BY id FOR UPDATE;
  v_pids := ARRAY(SELECT DISTINCT product_id FROM stock_reception_items WHERE reception_id = p_reception_id ORDER BY 1);
  PERFORM 1 FROM products WHERE id = ANY (v_pids) ORDER BY id FOR UPDATE;

  -- Le stock de cette réception est-il encore là ? Sinon (vendu, réservé, déplacé) : REFUS, aucune régularisation incohérente automatique.
  FOR x IN
    SELECT i.product_id, sum(i.quantity)::int AS q, pa.product_name, pa.physical, pa.reserved, pa.available
    FROM stock_reception_items i JOIN product_availability pa ON pa.product_id = i.product_id
    WHERE i.reception_id = p_reception_id GROUP BY i.product_id, pa.product_name, pa.physical, pa.reserved, pa.available
  LOOP
    IF x.available < x.q THEN
      RAISE EXCEPTION 'STOCK_DEJA_ENGAGE : % — % à retirer mais seulement % disponible(s) (physique %, réservé %) : une partie a déjà été vendue, réservée ou déplacée ; régularisez le stock à la main avant d''annuler', x.product_name, x.q, x.available, x.physical, x.reserved;
    END IF;
  END LOOP;

  PERFORM set_config('inca.achats_ecriture', '1', true);
  SELECT coalesce(jsonb_agg(jsonb_build_object('shipment_item_id', shipment_item_id, 'product_id', product_id, 'quantity', quantity, 'unit_cost_ht', unit_cost_ht)), '[]'::jsonb), count(*)::int
    INTO v_lignes, v_attendu FROM stock_reception_items WHERE reception_id = p_reception_id;
  IF v_attendu = 0 THEN RAISE EXCEPTION 'RECEPTION_VIDE'; END IF;
  INSERT INTO stock_reception_items_annulees (id, reception_id, product_id, quantity, unit_cost_ht, dlc, shipment_item_id, created_at)
  SELECT id, reception_id, product_id, quantity, unit_cost_ht, dlc, shipment_item_id, created_at FROM stock_reception_items WHERE reception_id = p_reception_id;
  DELETE FROM stock_reception_items WHERE reception_id = p_reception_id;
  UPDATE stock_receptions SET annulee_le = now(), annulee_par = p_acteur_email, annulation_motif = v_motif WHERE id = p_reception_id;
  UPDATE shipment_items i SET received_quantity = coalesce(i.received_quantity, 0) - a.q
  FROM (SELECT shipment_item_id AS id, sum(quantity)::int AS q FROM stock_reception_items_annulees WHERE reception_id = p_reception_id GROUP BY 1) a
  WHERE i.id = a.id AND coalesce(i.received_quantity, 0) >= a.q;
  GET DIAGNOSTICS v_maj = ROW_COUNT;
  IF v_maj <> (SELECT count(DISTINCT shipment_item_id) FROM stock_reception_items_annulees WHERE reception_id = p_reception_id) THEN RAISE EXCEPTION 'CUMUL_INCOHERENT'; END IF;
  UPDATE products p SET stock_quantity = p.stock_quantity - a.q, in_stock = (p.stock_quantity - a.q) > 0
  FROM (SELECT product_id AS pid, sum(quantity)::int AS q FROM stock_reception_items_annulees WHERE reception_id = p_reception_id GROUP BY 1) a
  WHERE p.id = a.pid;
  PERFORM recalc_pump(v_pids);

  v_quant := shipment_reception_quantites(v_ship);
  IF s.status = 'receptionne' AND NOT (v_quant->>'solde')::boolean THEN                                  -- la commande n'est plus soldée : on rouvre son statut logistique
    UPDATE shipments SET status = coalesce(s.statut_avant_reception, 'arrive_port'), statut_avant_reception = NULL WHERE id = v_ship;
  END IF;
  v_etat := shipment_reception_etat(v_ship);
  INSERT INTO admin_audit_logs (admin_email, action, target_type, target_id, target_label, details)
  VALUES (p_acteur_email, 'reception.annulation', 'shipment', v_ship::text, coalesce(s.reference, s.supplier_name),
          jsonb_build_object('reception_id', p_reception_id, 'motif', v_motif, 'received_at', r.received_at, 'bl', r.bl_fournisseur, 'auteur_initial', r.created_by_email, 'lignes', v_lignes, 'etat', v_etat));
  PERFORM set_config('inca.achats_ecriture', '', true);
  RETURN jsonb_build_object('reception_id', p_reception_id, 'annulee', true, 'etat', v_etat);
END $$;

-- ── 7. Modifier la quantité COMMANDÉE d'une ligne : administrateur, motif obligatoire, historique ──────────────────────────────
-- Jamais automatique. Jamais en dessous de ce qui est déjà reçu. Permet d'accepter un surplus (hausse) ou de SOLDER une commande que le fournisseur
-- ne livrera pas en entier (baisse jusqu'au reçu).
CREATE OR REPLACE FUNCTION shipment_item_quantite_modifier(p_item_id uuid, p_nouvelle integer, p_motif text, p_acteur_id uuid, p_acteur_email text, p_acteur_role text) RETURNS jsonb
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE l shipment_items%ROWTYPE; s shipments%ROWTYPE; v_ship uuid; v_motif text := nullif(btrim(coalesce(p_motif, '')), ''); v_etat jsonb; v_quant jsonb;
BEGIN
  IF p_acteur_role IS DISTINCT FROM 'admin' OR p_acteur_id IS NULL OR nullif(btrim(coalesce(p_acteur_email, '')), '') IS NULL THEN RAISE EXCEPTION 'ACTION_INTERDITE'; END IF;
  IF v_motif IS NULL OR length(v_motif) < 3 THEN RAISE EXCEPTION 'MOTIF_REQUIS'; END IF;
  IF p_nouvelle IS NULL OR p_nouvelle < 1 OR p_nouvelle > 9999999 THEN RAISE EXCEPTION 'QUANTITE_INVALIDE'; END IF;
  SELECT shipment_id INTO v_ship FROM shipment_items WHERE id = p_item_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'LIGNE_INCONNUE'; END IF;
  SELECT * INTO s FROM shipments WHERE id = v_ship FOR UPDATE;
  SELECT * INTO l FROM shipment_items WHERE id = p_item_id FOR UPDATE;
  IF s.status = 'annule' THEN RAISE EXCEPTION 'COMMANDE_ANNULEE'; END IF;
  IF (shipment_reception_etat(v_ship)->>'historique')::boolean THEN RAISE EXCEPTION 'COMMANDE_CLOTUREE_HISTORIQUE'; END IF;
  IF p_nouvelle < coalesce(l.received_quantity, 0) THEN RAISE EXCEPTION 'QUANTITE_INFERIEURE_AU_RECU : % déjà reçu(s)', coalesce(l.received_quantity, 0); END IF;
  IF p_nouvelle = l.quantity THEN RAISE EXCEPTION 'AUCUN_CHANGEMENT'; END IF;
  PERFORM set_config('inca.achats_ecriture', '1', true);
  UPDATE shipment_items SET quantity = p_nouvelle WHERE id = p_item_id;
  INSERT INTO shipment_item_quantites_historique (shipment_item_id, shipment_id, product_id, ancienne, nouvelle, motif, par_id, par_email)
  VALUES (p_item_id, v_ship, l.product_id, l.quantity, p_nouvelle, v_motif, p_acteur_id, p_acteur_email);
  v_quant := shipment_reception_quantites(v_ship);
  IF (v_quant->>'solde')::boolean AND s.status <> 'receptionne' THEN
    UPDATE shipments SET statut_avant_reception = s.status, status = 'receptionne' WHERE id = v_ship;
  ELSIF s.status = 'receptionne' AND NOT (v_quant->>'solde')::boolean THEN
    UPDATE shipments SET status = coalesce(s.statut_avant_reception, 'arrive_port'), statut_avant_reception = NULL WHERE id = v_ship;
  END IF;
  v_etat := shipment_reception_etat(v_ship);
  INSERT INTO admin_audit_logs (admin_email, action, target_type, target_id, target_label, details)
  VALUES (p_acteur_email, 'commande.quantite', 'shipment', v_ship::text, coalesce(s.reference, s.supplier_name),
          jsonb_build_object('ligne', p_item_id, 'produit', l.product_id, 'ancienne', l.quantity, 'nouvelle', p_nouvelle, 'motif', v_motif, 'etat', v_etat));
  PERFORM set_config('inca.achats_ecriture', '', true);
  RETURN jsonb_build_object('shipment_item_id', p_item_id, 'ancienne', l.quantity, 'nouvelle', p_nouvelle, 'etat', v_etat);
END $$;

-- ── 8. Droits : serveur seulement ────────────────────────────────────────────────────────────────────────────────────────
REVOKE EXECUTE ON FUNCTION
  shipment_reception_quantites(uuid), shipment_reception_etat(uuid),
  reception_commande_enregistrer(uuid, uuid, date, text, text, jsonb, uuid, text, text),
  reception_commande_annuler(uuid, text, uuid, text, text),
  shipment_item_quantite_modifier(uuid, integer, text, uuid, text, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION
  shipment_reception_quantites(uuid), shipment_reception_etat(uuid),
  reception_commande_enregistrer(uuid, uuid, date, text, text, jsonb, uuid, text, text),
  reception_commande_annuler(uuid, text, uuid, text, text),
  shipment_item_quantite_modifier(uuid, integer, text, uuid, text, text)
  TO service_role;
REVOKE EXECUTE ON FUNCTION shipment_items_proteger(), shipments_proteger(), stock_receptions_proteger(), stock_reception_items_proteger(), achats_historique_proteger()
  FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON COLUMN stock_receptions.shipment_id IS 'Commande fournisseur (expédition) à laquelle cette réception est rattachée ; NULL pour les réceptions historiques.';
COMMENT ON COLUMN shipment_items.received_quantity IS 'Cumul réceptionné de la ligne : modifié UNIQUEMENT par reception_commande_enregistrer / reception_commande_annuler (déclencheur de protection).';

COMMIT;

-- ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────
-- Retour arrière (tant qu'aucune réception de commande n'a été enregistrée ; sinon des traces seraient perdues) :
--   DROP FUNCTION reception_commande_enregistrer(uuid, uuid, date, text, text, jsonb, uuid, text, text), reception_commande_annuler(uuid, text, uuid, text, text),
--     shipment_item_quantite_modifier(uuid, integer, text, uuid, text, text), shipment_reception_etat(uuid), shipment_reception_quantites(uuid);
--   DROP TRIGGER trg_shipment_items_proteger / _truncate ON shipment_items ; trg_shipments_proteger ON shipments ; trg_stock_receptions_proteger / _truncate ON stock_receptions ;
--     trg_stock_reception_items_proteger / _truncate ON stock_reception_items ; puis DROP FUNCTION des fonctions de protection ;
--   DROP TABLE shipment_item_quantites_historique, stock_reception_items_annulees ;
--   ALTER TABLE stock_reception_items DROP COLUMN shipment_item_id ; ALTER TABLE shipments DROP COLUMN statut_avant_reception ;
--   ALTER TABLE stock_receptions DROP COLUMN shipment_id, cle_idempotence, empreinte, bl_fournisseur, created_by, created_by_email, annulee_le, annulee_par, annulation_motif.
