BEGIN;
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  channel_id TEXT NOT NULL,
  message_id TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL,
  data TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS tasks_message ON tasks(message_id);
CREATE INDEX IF NOT EXISTS tasks_channel ON tasks(channel_id);
INSERT INTO schema_version(version) VALUES (7);
COMMIT;
