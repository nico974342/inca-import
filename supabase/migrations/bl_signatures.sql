-- Signature électronique des bons de livraison (transporteur + destinataire).
-- Additif et rejouable. Ne touche à aucune donnée existante.
--
-- Une signature enregistrée est une PREUVE DE LIVRAISON : elle ne se modifie pas et ne se supprime pas.
--   - UPDATE : refusé, sauf l'annulation explicite (annulee_le / annulee_par / annulation_motif), qui ne change rien d'autre.
--   - DELETE : toujours refusé — y compris en cascade (supprimer un BL ou un client qui a des signatures échoue).
--   - TRUNCATE : refusé.
--   - Un trigger protège aussi le service_role : seule l'annulation est possible, et elle conserve la signature d'origine.
-- Une annulation libère la place : on peut re-signer le même rôle. L'unicité porte donc sur les signatures ACTIVES
-- (UNIQUE (delivery_note_id, role) WHERE annulee_le IS NULL) ; les signatures annulées restent en base comme trace.

-- 1. Contenu du BL mémorisé à la génération : permet de reproduire le PDF à l'identique, signatures comprises.
--    (NULL pour un BL antérieur à cette migration : il reste téléchargeable mais ne peut pas être signé.)
ALTER TABLE delivery_notes ADD COLUMN IF NOT EXISTS contenu jsonb;

-- 2. Bucket privé des PDF de BL. Il n'existait pas : l'enregistrement des BL échouait donc silencieusement.
INSERT INTO storage.buckets (id, name, public)
VALUES ('delivery-notes', 'delivery-notes', false)
ON CONFLICT (id) DO NOTHING;

-- 3. Signatures
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

-- 4. Preuve non modifiable
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

-- 5. Accès : uniquement le serveur de l'application (service_role). Aucun accès direct anon / authenticated.
ALTER TABLE bl_signatures ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON bl_signatures FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON bl_signatures TO service_role;

-- Contrôle après application (lecture seule) :
--   select to_regclass('public.bl_signatures'), (select count(*) from bl_signatures);   -- table présente, 0 ligne
--   select id, public from storage.buckets where id = 'delivery-notes';                  -- bucket privé
--   select count(*) from delivery_notes;                                                 -- inchangé
--
-- Retour arrière (retire la fonctionnalité ; les signatures éventuelles seraient perdues : à n'utiliser qu'avant tout usage) :
--   DROP TABLE IF EXISTS bl_signatures;
--   DROP FUNCTION IF EXISTS bl_signatures_proteger();
--   ALTER TABLE delivery_notes DROP COLUMN IF EXISTS contenu;
--   (le bucket 'delivery-notes' peut rester : il est vide et privé)
