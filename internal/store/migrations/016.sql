BEGIN;
CREATE TABLE IF NOT EXISTS bridge_binding_policy (
 bridge TEXT NOT NULL,
 conversation TEXT NOT NULL,
 channel_id TEXT NOT NULL,
 outbound_agents TEXT NOT NULL CHECK(outbound_agents IN ('send','draft','off')),
 PRIMARY KEY (bridge, conversation, channel_id)
);
CREATE TABLE IF NOT EXISTS bridge_delivery (
 bridge TEXT NOT NULL,
 delivery_key TEXT NOT NULL,
 PRIMARY KEY (bridge, delivery_key)
);
INSERT OR IGNORE INTO schema_version(version) VALUES (16);
COMMIT;
