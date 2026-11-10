-- Liaison explicite BL <-> commandes + création idempotente des BL (système commun Commandes / Livraison).
-- Prérequis : bl_signatures.sql (appliquée). Additif et rejouable. Ne modifie ni ne supprime AUCUNE donnée existante :
-- aucun UPDATE / DELETE / TRUNCATE de données, la numérotation (bl_number_seq, orders.bl_number) n'est pas touchée.
--
-- Modèle :
--   delivery_notes             = LE BL (numéro, PDF, contenu figé) — référence unique pour Commandes et Livraison.
--   delivery_note_orders       = liaison par IDENTIFIANTS DE COMMANDES (jamais par e-mail) :
--        1 BL <-> 1 commande, 1 BL regroupé <-> n commandes, n BL <-> 1 commande (livraison en plusieurs fois).
--   delivery_notes.cle_operation = clé d'idempotence : une même opération de livraison ne produit jamais deux BL
--        (double clic, rafraîchissement, renvoi du formulaire : la 2e demande retrouve le BL existant, sans nouveau numéro).
-- Les 77 anciens BL (orders.bl_number, signés sur papier) n'ont aucune ligne ici : ils restent tels quels.

-- 1. Clé d'opération (idempotence)
ALTER TABLE delivery_notes ADD COLUMN IF NOT EXISTS cle_operation text;
CREATE UNIQUE INDEX IF NOT EXISTS delivery_notes_cle_operation_uniq ON delivery_notes (cle_operation) WHERE cle_operation IS NOT NULL;

-- 2. Le BL établi reste figé : la clé d'opération rejoint les champs non modifiables
CREATE OR REPLACE FUNCTION delivery_notes_figer() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF (NEW.id, NEW.delivery_id, NEW.pdv_key, NEW.pdv_name, NEW.storage_path, NEW.created_at, NEW.cle_operation)
     IS DISTINCT FROM
     (OLD.id, OLD.delivery_id, OLD.pdv_key, OLD.pdv_name, OLD.storage_path, OLD.created_at, OLD.cle_operation) THEN
    RAISE EXCEPTION 'Un bon de livraison établi ne peut pas être modifié (numéro, fichier, point de vente).' USING ERRCODE = '42501';
  END IF;
  IF OLD.contenu IS NOT NULL AND NEW.contenu IS DISTINCT FROM OLD.contenu THEN
    RAISE EXCEPTION 'Le contenu d''un bon de livraison établi est figé : il ne peut pas être modifié.' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;

-- 3. Liaison BL <-> commandes
CREATE TABLE IF NOT EXISTS delivery_note_orders (
  delivery_note_id   uuid NOT NULL REFERENCES delivery_notes(id) ON DELETE CASCADE,
  order_id           uuid NOT NULL REFERENCES orders(id) ON DELETE RESTRICT,   -- une commande liée à un BL ne peut pas être supprimée
  empreinte_commande text NOT NULL CHECK (length(empreinte_commande) > 0),    -- état des lignes de la commande à l'émission du BL (détecte une modification ultérieure)
  created_at         timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (delivery_note_id, order_id)
);
CREATE INDEX IF NOT EXISTS delivery_note_orders_par_commande ON delivery_note_orders (order_id);

-- La liaison est une preuve : jamais modifiée. Elle ne disparaît que si son BL (non signé) est supprimé (cascade).
CREATE OR REPLACE FUNCTION delivery_note_orders_proteger() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF TG_OP = 'TRUNCATE' THEN
    RAISE EXCEPTION 'Les liaisons BL / commandes ne peuvent pas être vidées.' USING ERRCODE = '42501';
  END IF;
  RAISE EXCEPTION 'La liaison entre un bon de livraison et ses commandes ne peut pas être modifiée.' USING ERRCODE = '42501';
END $$;

DROP TRIGGER IF EXISTS trg_delivery_note_orders_proteger ON delivery_note_orders;
CREATE TRIGGER trg_delivery_note_orders_proteger
  BEFORE UPDATE ON delivery_note_orders
  FOR EACH ROW EXECUTE FUNCTION delivery_note_orders_proteger();
DROP TRIGGER IF EXISTS trg_delivery_note_orders_proteger_truncate ON delivery_note_orders;
CREATE TRIGGER trg_delivery_note_orders_proteger_truncate
  BEFORE TRUNCATE ON delivery_note_orders
  FOR EACH STATEMENT EXECUTE FUNCTION delivery_note_orders_proteger();

-- 4. Création atomique et idempotente d'un BL : numéro, ligne, contenu figé et liaisons dans UNE transaction.
--    Une même clé d'opération renvoie toujours le même BL (bl_cree = false) et ne consomme aucun numéro.
--    p_commandes = [{"order_id": "<uuid>", "empreinte": "<hash>"}, ...]  (peut être vide : BL libre, non rattaché).
CREATE OR REPLACE FUNCTION bl_creer(p_cle text, p_client_id uuid, p_pdv_key text, p_pdv_name text, p_contenu jsonb, p_commandes jsonb)
RETURNS TABLE (bl_id uuid, bl_numero text, bl_chemin text, bl_cree boolean)
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  v_note   delivery_notes%ROWTYPE;
  v_num    text;
  v_cmd    jsonb;
  v_statut text;
BEGIN
  IF p_cle IS NULL OR length(btrim(p_cle)) = 0 THEN RAISE EXCEPTION 'Clé d''opération obligatoire.'; END IF;
  IF p_contenu IS NULL OR p_contenu->'pdv' IS NULL THEN RAISE EXCEPTION 'Contenu du BL obligatoire.'; END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(p_cle, 0));   -- deux demandes simultanées de la même opération s'exécutent l'une après l'autre

  SELECT * INTO v_note FROM delivery_notes d WHERE d.cle_operation = p_cle;
  IF FOUND THEN
    RETURN QUERY SELECT v_note.id, v_note.delivery_id, v_note.storage_path, false;
    RETURN;
  END IF;

  FOR v_cmd IN SELECT * FROM jsonb_array_elements(coalesce(p_commandes, '[]'::jsonb)) LOOP
    SELECT o.status INTO v_statut FROM orders o WHERE o.id = (v_cmd->>'order_id')::uuid;
    IF NOT FOUND THEN RAISE EXCEPTION 'Commande introuvable : %', v_cmd->>'order_id'; END IF;
    IF v_statut = 'annulee' THEN RAISE EXCEPTION 'Commande annulée : aucun BL possible (%).', v_cmd->>'order_id'; END IF;
  END LOOP;

  v_num := next_bl_number();
  INSERT INTO delivery_notes (delivery_id, client_id, pdv_key, pdv_name, storage_path, contenu, cle_operation)
  VALUES (v_num, p_client_id, p_pdv_key, p_pdv_name, v_num || '/' || p_pdv_key || '.pdf', p_contenu, p_cle)
  RETURNING * INTO v_note;

  INSERT INTO delivery_note_orders (delivery_note_id, order_id, empreinte_commande)
  SELECT v_note.id, (e->>'order_id')::uuid, e->>'empreinte' FROM jsonb_array_elements(coalesce(p_commandes, '[]'::jsonb)) e;

  RETURN QUERY SELECT v_note.id, v_note.delivery_id, v_note.storage_path, true;
END $$;

-- 5. Accès : uniquement le serveur de l'application (service_role) ; ni modification ni suppression directes de la liaison
ALTER TABLE delivery_note_orders ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON delivery_note_orders FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT ON delivery_note_orders TO service_role;
REVOKE ALL ON FUNCTION bl_creer(text, uuid, text, text, jsonb, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION bl_creer(text, uuid, text, text, jsonb, jsonb) TO service_role;
REVOKE ALL ON FUNCTION delivery_note_orders_proteger() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION delivery_notes_figer() FROM PUBLIC, anon, authenticated;

-- Retour arrière — UNIQUEMENT avant tout usage réel (aucune liaison créée) :
--   DROP FUNCTION IF EXISTS bl_creer(text, uuid, text, text, jsonb, jsonb);
--   DROP TABLE IF EXISTS delivery_note_orders;
--   DROP FUNCTION IF EXISTS delivery_note_orders_proteger();
--   DROP INDEX IF EXISTS delivery_notes_cle_operation_uniq;
--   ALTER TABLE delivery_notes DROP COLUMN IF EXISTS cle_operation;
--   (delivery_notes_figer() peut rester : sa version précédente ignorait seulement cle_operation, qui n'existerait plus)
-- Après usage réel : revenir en arrière = rétablir la version précédente du code (Vercel) ; on garde les tables.
