BEGIN;
CREATE TABLE IF NOT EXISTS lessons (
 id TEXT PRIMARY KEY,
 persona TEXT NOT NULL,
 channel_id TEXT NOT NULL DEFAULT '',
 text TEXT NOT NULL,
 source_message_id TEXT NOT NULL DEFAULT '',
 created_by TEXT NOT NULL,
 created_at TEXT NOT NULL,
 updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS lessons_persona ON lessons(persona, created_at DESC, id DESC);
INSERT INTO schema_version(version) VALUES (12);
COMMIT;
