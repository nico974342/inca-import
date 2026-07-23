-- H4: canonical email form is LOWER(TRIM(email)) everywhere.
-- client_accounts.email is UNIQUE, so skip any row whose lowercased form
-- would collide with another row (those duplicates need manual merging).
UPDATE client_accounts c
SET email = LOWER(TRIM(c.email))
WHERE c.email IS NOT NULL
  AND c.email <> LOWER(TRIM(c.email))
  AND NOT EXISTS (
    SELECT 1 FROM client_accounts o
    WHERE o.id <> c.id
      AND LOWER(TRIM(o.email)) = LOWER(TRIM(c.email))
  );

UPDATE orders
SET email = LOWER(TRIM(email))
WHERE email IS NOT NULL AND email <> LOWER(TRIM(email));

UPDATE contact_requests
SET email = LOWER(TRIM(email))
WHERE email IS NOT NULL AND email <> LOWER(TRIM(email));
