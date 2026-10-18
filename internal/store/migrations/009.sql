BEGIN;
CREATE TABLE bridge_cursor (
 bridge TEXT PRIMARY KEY,
 seq INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE bridge_outbound (
 bridge TEXT NOT NULL,
 external_id TEXT NOT NULL,
 message_id TEXT NOT NULL DEFAULT '',
 approval_id TEXT NOT NULL DEFAULT '',
 PRIMARY KEY (bridge, external_id)
);
INSERT INTO schema_version(version) VALUES (9);
COMMIT;
