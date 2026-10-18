BEGIN;
CREATE TABLE IF NOT EXISTS pins (
  channel_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  pinned_by TEXT NOT NULL,
  pinned_at TEXT NOT NULL,
  PRIMARY KEY (channel_id, message_id)
);
INSERT INTO schema_version(version) VALUES (6);
COMMIT;
