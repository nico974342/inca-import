-- Folds prospecting into client_accounts: prospects become client_accounts
-- rows with status = 'prospect' instead of a separate table/page. Run this
-- BEFORE deploying the code that uses it. If prospects_table.sql (from the
-- earlier standalone /admin/prospects feature) was never run, the "copy
-- existing prospects" step below is a no-op.

ALTER TABLE client_accounts DROP CONSTRAINT IF EXISTS client_accounts_status_check;
ALTER TABLE client_accounts ADD CONSTRAINT client_accounts_status_check
  CHECK (status IN ('prospect', 'en_attente', 'actif', 'suspendu'));

ALTER TABLE client_accounts ADD COLUMN IF NOT EXISTS type    TEXT CHECK (type IN ('station_service', 'superette', 'autre'));
ALTER TABLE client_accounts ADD COLUMN IF NOT EXISTS commune TEXT;

-- Email is UNIQUE on client_accounts but prospects may have none — allow
-- NULL (already nullable) and let multiple prospects share a NULL email;
-- a real UNIQUE constraint already ignores NULLs in Postgres, so no change
-- needed there.

-- Copy over any rows from the old standalone prospects table, skipping ones
-- that already made it into client_accounts (matched by email) so nothing
-- is duplicated. All prior sub-statuses (à_contacter/contacté/intéressé/
-- pas_intéressé/converti) collapse to the single 'prospect' status; the
-- previous sub-status and follow-up dates are preserved in notes for
-- reference since client_accounts has no equivalent columns.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'prospects') THEN
    INSERT INTO client_accounts (nom, societe, type, commune, telephone, email, notes, status)
    SELECT
      p.nom, p.societe, p.type, p.commune, p.telephone, p.email,
      NULLIF(
        trim(both ' — ' from
          concat_ws(' — ',
            'Ancien statut prospect : ' || p.status,
            NULLIF(p.notes, '')
          )
        ),
        ''
      ),
      'prospect'
    FROM prospects p
    WHERE p.status <> 'converti'
      AND NOT EXISTS (
        SELECT 1 FROM client_accounts c
        WHERE p.email IS NOT NULL AND lower(trim(c.email)) = lower(trim(p.email))
      );

    DROP TABLE prospects;
  END IF;
END $$;
