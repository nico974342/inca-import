-- Signature électronique des bons de livraison (transporteur + destinataire).
-- Additif et rejouable. Ne supprime ni ne modifie AUCUNE donnée existante.
-- (Aucun UPDATE / DELETE / TRUNCATE de données ; seuls des ajouts de colonne, d'index, de table, de fonctions et de triggers.)
--
-- PREUVE DE LIVRAISON — garanties portées par la base elle-même, y compris contre le serveur (service_role) :
--   * une signature ne se modifie pas (seule l'annulation motivée est possible, une fois) ;
--   * une signature ne se supprime pas : ni directement, ni en cascade (BL, client), ni par TRUNCATE ;
--   * le contenu du BL (numéro, PDF, lignes, adresse) est figé : une modification ultérieure est refusée ;
--   * chaque signature et chaque annulation est inscrite dans admin_audit_logs DANS LA MÊME TRANSACTION :
--     si le journal ne peut pas être écrit, la signature n'est pas enregistrée (jamais de signature sans trace).
-- Une annulation libère la place (on peut re-signer le rôle) ; la signature annulée reste en base comme trace.
-- L'unicité porte donc sur les signatures ACTIVES : UNIQUE (delivery_note_id, role) WHERE annulee_le IS NULL.

-- 1. Cause de l'absence de BL enregistrés : le bucket « delivery-notes » n'existait pas, l'envoi du PDF échouait
--    (« Bucket not found ») et l'enregistrement de la ligne delivery_notes était abandonné. On le crée : privé, PDF seulement.
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('delivery-notes', 'delivery-notes', false, 10485760, ARRAY['application/pdf'])
ON CONFLICT (id) DO NOTHING;
-- Aucune politique sur storage.objects pour ce bucket : seul le serveur (service_role) y accède, via des liens signés.

-- 2. Contenu du BL mémorisé à la génération : permet de reproduire le PDF à l'identique, signatures comprises.
--    (NULL pour un BL antérieur à cette migration : il reste téléchargeable mais ne peut pas être signé.)
ALTER TABLE delivery_notes ADD COLUMN IF NOT EXISTS contenu jsonb;
CREATE UNIQUE INDEX IF NOT EXISTS delivery_notes_delivery_id_uniq ON delivery_notes (delivery_id);   -- un numéro de BL = une ligne

-- 3. Un BL établi est figé. Seul client_id peut changer (la clé étrangère le met à NULL si le client est supprimé).
CREATE OR REPLACE FUNCTION delivery_notes_figer() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF (NEW.id, NEW.delivery_id, NEW.pdv_key, NEW.pdv_name, NEW.storage_path, NEW.created_at)
     IS DISTINCT FROM
     (OLD.id, OLD.delivery_id, OLD.pdv_key, OLD.pdv_name, OLD.storage_path, OLD.created_at) THEN
    RAISE EXCEPTION 'Un bon de livraison établi ne peut pas être modifié (numéro, fichier, point de vente).' USING ERRCODE = '42501';
  END IF;
  IF OLD.contenu IS NOT NULL AND NEW.contenu IS DISTINCT FROM OLD.contenu THEN
    RAISE EXCEPTION 'Le contenu d''un bon de livraison établi est figé : il ne peut pas être modifié.' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_delivery_notes_figer ON delivery_notes;
CREATE TRIGGER trg_delivery_notes_figer
  BEFORE UPDATE ON delivery_notes
  FOR EACH ROW EXECUTE FUNCTION delivery_notes_figer();

-- 4. Signatures
CREATE TABLE IF NOT EXISTS bl_signatures (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  delivery_note_id uuid NOT NULL REFERENCES delivery_notes(id) ON DELETE CASCADE,
  role             text NOT NULL CHECK (role IN ('transporteur', 'destinataire')),
  signature_data   text NOT NULL
                     CHECK (signature_data LIKE 'data:image/png;base64,%' AND length(signature_data) <= 400000),
  signataire_nom   text NOT NULL CHECK (length(btrim(signataire_nom)) BETWEEN 1 AND 100),
  signed_at        timestamptz NOT NULL DEFAULT now(),
  signed_by        text NOT NULL CHECK (length(btrim(signed_by)) > 0),
  created_at       timestamptz NOT NULL DEFAULT now(),
  annulee_le       timestamptz,
  annulee_par      text,
  annulation_motif text,
  CONSTRAINT bl_signatures_annulation_complete CHECK (
    (annulee_le IS NULL AND annulee_par IS NULL AND annulation_motif IS NULL)
    OR (annulee_le IS NOT NULL AND annulee_par IS NOT NULL AND length(btrim(coalesce(annulation_motif, ''))) > 0)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS bl_signatures_une_active_par_role
  ON bl_signatures (delivery_note_id, role) WHERE annulee_le IS NULL;
CREATE INDEX IF NOT EXISTS bl_signatures_par_bl ON bl_signatures (delivery_note_id);

-- 5. Preuve non modifiable
CREATE OR REPLACE FUNCTION bl_signatures_proteger() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF TG_OP = 'TRUNCATE' THEN
    RAISE EXCEPTION 'Les signatures de bons de livraison ne peuvent pas être vidées (preuve de livraison).' USING ERRCODE = '42501';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Une signature de bon de livraison ne peut pas être supprimée (preuve de livraison). Utilisez l''annulation.' USING ERRCODE = '42501';
  END IF;
  -- UPDATE : uniquement l'annulation explicite, une seule fois, sans toucher à la signature
  IF OLD.annulee_le IS NOT NULL THEN
    RAISE EXCEPTION 'Cette signature est déjà annulée : elle n''est plus modifiable.' USING ERRCODE = '42501';
  END IF;
  IF NEW.annulee_le IS NULL OR NEW.annulee_par IS NULL OR length(btrim(coalesce(NEW.annulation_motif, ''))) = 0 THEN
    RAISE EXCEPTION 'Une signature enregistrée ne peut pas être modifiée. Seule l''annulation motivée est possible.' USING ERRCODE = '42501';
  END IF;
  IF (NEW.id, NEW.delivery_note_id, NEW.role, NEW.signature_data, NEW.signataire_nom, NEW.signed_at, NEW.signed_by, NEW.created_at)
     IS DISTINCT FROM
     (OLD.id, OLD.delivery_note_id, OLD.role, OLD.signature_data, OLD.signataire_nom, OLD.signed_at, OLD.signed_by, OLD.created_at) THEN
    RAISE EXCEPTION 'L''annulation ne doit modifier que les champs d''annulation.' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_bl_signatures_proteger ON bl_signatures;
CREATE TRIGGER trg_bl_signatures_proteger
  BEFORE UPDATE OR DELETE ON bl_signatures
  FOR EACH ROW EXECUTE FUNCTION bl_signatures_proteger();

DROP TRIGGER IF EXISTS trg_bl_signatures_proteger_truncate ON bl_signatures;
CREATE TRIGGER trg_bl_signatures_proteger_truncate
  BEFORE TRUNCATE ON bl_signatures
  FOR EACH STATEMENT EXECUTE FUNCTION bl_signatures_proteger();

-- 6. Journal d'audit écrit par la base, dans la même transaction que la signature ou l'annulation.
--    (admin_email = la personne qui a fait signer / qui a annulé ; empreinte = md5 de l'image, pour retrouver la signature.)
CREATE OR REPLACE FUNCTION bl_signatures_journal() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  libelle text;
BEGIN
  SELECT d.delivery_id || ' — ' || d.pdv_name INTO libelle FROM delivery_notes d WHERE d.id = NEW.delivery_note_id;
  IF TG_OP = 'INSERT' THEN
    INSERT INTO admin_audit_logs (admin_email, action, target_type, target_id, target_label, details)
    VALUES (NEW.signed_by, 'bl.signature', 'bl', NEW.delivery_note_id::text, libelle,
            jsonb_build_object('role', NEW.role, 'signataire_nom', NEW.signataire_nom, 'signature_id', NEW.id,
                               'signed_at', NEW.signed_at, 'empreinte', md5(NEW.signature_data)));
  ELSIF OLD.annulee_le IS NULL AND NEW.annulee_le IS NOT NULL THEN
    INSERT INTO admin_audit_logs (admin_email, action, target_type, target_id, target_label, details)
    VALUES (NEW.annulee_par, 'bl.signature_annulee', 'bl', NEW.delivery_note_id::text, libelle,
            jsonb_build_object('role', NEW.role, 'signataire_nom', NEW.signataire_nom, 'signature_id', NEW.id,
                               'signed_by', NEW.signed_by, 'signed_at', NEW.signed_at, 'motif', NEW.annulation_motif,
                               'empreinte', md5(NEW.signature_data)));
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_bl_signatures_journal ON bl_signatures;
CREATE TRIGGER trg_bl_signatures_journal
  AFTER INSERT OR UPDATE ON bl_signatures
  FOR EACH ROW EXECUTE FUNCTION bl_signatures_journal();

-- 7. Accès : uniquement le serveur de l'application (service_role). Aucun accès direct anon / authenticated.
ALTER TABLE bl_signatures ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON bl_signatures FROM PUBLIC, anon, authenticated, service_role;   -- annule aussi les droits par défaut de Supabase
GRANT SELECT, INSERT, UPDATE ON bl_signatures TO service_role;               -- pas de DELETE, pas de TRUNCATE (les triggers le refusent aussi)
REVOKE ALL ON delivery_notes FROM PUBLIC, anon, authenticated;     -- déjà inaccessible par RLS ; l'application n'utilise que le service_role
REVOKE ALL ON FUNCTION bl_signatures_proteger() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION bl_signatures_journal() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION delivery_notes_figer() FROM PUBLIC, anon, authenticated;

-- Contrôles après application (lecture seule) : voir docs ou la procédure de mise en production.
--
-- Retour arrière — UNIQUEMENT avant tout usage réel (la suppression de la table détruirait des signatures) :
--   DROP TRIGGER IF EXISTS trg_bl_signatures_journal ON bl_signatures;
--   DROP TABLE IF EXISTS bl_signatures;
--   DROP FUNCTION IF EXISTS bl_signatures_journal(), bl_signatures_proteger();
--   DROP TRIGGER IF EXISTS trg_delivery_notes_figer ON delivery_notes;
--   DROP FUNCTION IF EXISTS delivery_notes_figer();
--   DROP INDEX IF EXISTS delivery_notes_delivery_id_uniq;
--   ALTER TABLE delivery_notes DROP COLUMN IF EXISTS contenu;
--   (le bucket « delivery-notes » peut rester : il est vide et privé ; les droits retirés à anon/authenticated sur delivery_notes n'ont aucun effet sur l'application)
-- Après usage réel : revenir en arrière = rétablir la version précédente du code (Vercel) ; on garde la table et ses signatures.
