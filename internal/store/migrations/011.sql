BEGIN;
CREATE INDEX IF NOT EXISTS events_run_prompt ON events(json_extract(payload,'$.run_id'), seq) WHERE type='run.prompt';
INSERT INTO schema_version(version) VALUES (11);
COMMIT;
