-- "Actions de la semaine" — a lightweight admin-only task list on the
-- dashboard. No week/user scoping by design: it's a single shared list for
-- whoever is running the shop, cleared out manually or left to age.
CREATE TABLE IF NOT EXISTS weekly_tasks (
  id         UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  content    TEXT NOT NULL,
  done       BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  done_at    TIMESTAMPTZ
);

ALTER TABLE weekly_tasks ENABLE ROW LEVEL SECURITY;
-- No public policies — accessible only via the service role key (admin dashboard).

CREATE INDEX IF NOT EXISTS weekly_tasks_done_idx ON weekly_tasks(done);
