BEGIN;
CREATE TABLE events_v2 (
 seq INTEGER PRIMARY KEY, id TEXT NOT NULL UNIQUE, version INTEGER NOT NULL,
 type TEXT NOT NULL, actor TEXT NOT NULL, channel_id TEXT NOT NULL DEFAULT '',
 idempotency_key TEXT, payload BLOB NOT NULL, ts TEXT NOT NULL
);
INSERT INTO events_v2(seq,id,version,type,actor,channel_id,idempotency_key,payload,ts)
 SELECT seq,id,version,type,actor,channel_id,idempotency_key,payload,ts FROM events;
DROP TABLE events;
ALTER TABLE events_v2 RENAME TO events;
CREATE UNIQUE INDEX events_channel_key ON events(channel_id,idempotency_key);
INSERT INTO schema_version(version) VALUES (2);
COMMIT;
