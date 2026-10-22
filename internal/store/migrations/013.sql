BEGIN;
CREATE TABLE IF NOT EXISTS app_routines (
  handle TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  prompt TEXT NOT NULL,
  persona TEXT NOT NULL,
  channel TEXT NOT NULL,
  schedule TEXT NOT NULL DEFAULT '',
  trigger TEXT NOT NULL DEFAULT '',
  enabled INTEGER NOT NULL DEFAULT 1,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL
);
INSERT INTO schema_version(version) VALUES (13);
COMMIT;
