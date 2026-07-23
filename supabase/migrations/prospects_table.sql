-- Prospecting/CRM tracker: prospects are pre-client outreach contacts,
-- distinct from contact_requests (public site form submissions) and
-- client_accounts (active accounts). A prospect becomes a client_accounts
-- row via the "Convertir en client" action once status = 'converti'.
CREATE TABLE IF NOT EXISTS prospects (
  id                UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  nom               TEXT NOT NULL,
  societe           TEXT,
  type              TEXT CHECK (type IN ('station_service', 'superette', 'autre')),
  commune           TEXT,
  telephone         TEXT,
  email             TEXT,
  notes             TEXT,
  status            TEXT NOT NULL DEFAULT 'a_contacter'
                      CHECK (status IN ('a_contacter', 'contacte', 'interesse', 'converti', 'pas_interesse')),
  last_contact_at   DATE,
  next_followup_at  DATE,
  created_at        TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE prospects ENABLE ROW LEVEL SECURITY;
-- No public policies — accessible only via the service role key (admin pages),
-- matching contact_requests and client_accounts.

CREATE INDEX IF NOT EXISTS prospects_status_idx   ON prospects(status);
CREATE INDEX IF NOT EXISTS prospects_followup_idx ON prospects(next_followup_at);
CREATE INDEX IF NOT EXISTS prospects_commune_idx   ON prospects(commune);
