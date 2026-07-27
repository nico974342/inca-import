-- Internal admin-to-admin chat (Nico/Arnaud). Polled from the client rather
-- than pushed, so no realtime/websocket setup is needed here.
CREATE TABLE IF NOT EXISTS admin_messages (
  id           UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  sender_email TEXT NOT NULL,
  content      TEXT NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE admin_messages ENABLE ROW LEVEL SECURITY;
-- No public policies — accessible only via the service role key (admin pages),
-- matching prospects/client_accounts/weekly_tasks.

CREATE INDEX IF NOT EXISTS admin_messages_created_at_idx ON admin_messages(created_at);
