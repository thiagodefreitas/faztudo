BEGIN;
CREATE TABLE IF NOT EXISTS suggestions (
  id TEXT PRIMARY KEY,
  channel_id TEXT NOT NULL,
  run_id TEXT NOT NULL DEFAULT '',
  state TEXT NOT NULL,
  created_at TEXT NOT NULL,
  data TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS suggestions_channel ON suggestions(channel_id, state);
CREATE INDEX IF NOT EXISTS suggestions_run ON suggestions(run_id);
INSERT INTO schema_version(version) VALUES (15);
COMMIT;
