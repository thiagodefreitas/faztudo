BEGIN;
CREATE INDEX IF NOT EXISTS events_run_output ON events(json_extract(payload,'$.run_id'), seq) WHERE type='run.output';
INSERT INTO schema_version(version) VALUES (10);
COMMIT;
