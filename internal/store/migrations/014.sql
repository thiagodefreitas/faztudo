BEGIN;
CREATE TABLE IF NOT EXISTS approval_rules (
  id TEXT PRIMARY KEY,
  channel_id TEXT NOT NULL,
  persona TEXT NOT NULL DEFAULT '',
  paths TEXT NOT NULL,
  max_lines INTEGER NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS approval_rules_channel ON approval_rules(channel_id);
INSERT INTO schema_version(version) VALUES (14);
COMMIT;
