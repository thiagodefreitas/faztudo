BEGIN;
CREATE TABLE lane_usage_history (
  seq INTEGER PRIMARY KEY,
  lane_id TEXT NOT NULL,
  window_name TEXT NOT NULL,
  measured_at TEXT NOT NULL,
  data BLOB NOT NULL
);
CREATE INDEX lane_usage_history_lookup ON lane_usage_history(lane_id, window_name, measured_at);
CREATE INDEX lane_usage_history_age ON lane_usage_history(measured_at);
CREATE TABLE channel_summaries (
  channel_id TEXT PRIMARY KEY,
  data BLOB NOT NULL
);
INSERT INTO schema_version(version) VALUES (5);
COMMIT;
