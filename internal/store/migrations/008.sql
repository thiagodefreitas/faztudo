BEGIN;
-- Lookups of a few event types (compare groups) without scanning the log.
CREATE INDEX IF NOT EXISTS events_type_channel ON events(type, channel_id, seq);
INSERT INTO schema_version(version) VALUES (8);
COMMIT;
