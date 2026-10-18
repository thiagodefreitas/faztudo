BEGIN;
CREATE TABLE IF NOT EXISTS org (
  kind TEXT NOT NULL,
  handle TEXT NOT NULL,
  data BLOB NOT NULL,
  PRIMARY KEY (kind, handle)
);
INSERT INTO schema_version(version) VALUES (4);
COMMIT;
