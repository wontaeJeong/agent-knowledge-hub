CREATE TABLE operations_backups (
 id text PRIMARY KEY, created_at timestamptz NOT NULL DEFAULT now(), completed_at timestamptz,
 target text NOT NULL, key_id text NOT NULL, checksum text, status text NOT NULL CHECK(status IN ('running','complete','failed'))
);
CREATE TABLE operations_tombstones (
 workspace_id text NOT NULL REFERENCES workspaces(id), id text NOT NULL,
 resource_kind text NOT NULL CHECK(resource_kind IN ('source','page')), resource_id text NOT NULL,
 blob_hashes jsonb NOT NULL DEFAULT '[]', allowed_readers jsonb NOT NULL DEFAULT '[]',
 delete_content boolean NOT NULL DEFAULT false, approved_by text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(workspace_id,id)
);
CREATE TABLE operations_policy (
 workspace_id text PRIMARY KEY REFERENCES workspaces(id), revision integer NOT NULL DEFAULT 1,
 audit_days integer NOT NULL DEFAULT 365 CHECK(audit_days BETWEEN 1 AND 3650),
 telemetry_days integer NOT NULL DEFAULT 30 CHECK(telemetry_days BETWEEN 1 AND 365),
 backup_days integer NOT NULL DEFAULT 30 CHECK(backup_days BETWEEN 1 AND 3650)
);
CREATE TABLE operations_audit_chain (
 workspace_id text NOT NULL REFERENCES workspaces(id), sequence bigint NOT NULL,
 event jsonb NOT NULL, previous_hash text NOT NULL, hash text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(workspace_id,sequence)
);
CREATE TABLE operations_alert_outbox (
 id text PRIMARY KEY, dedupe_key text NOT NULL UNIQUE, code text NOT NULL,
 state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','sending','sent')),
 attempts integer NOT NULL DEFAULT 0, next_attempt_at timestamptz NOT NULL DEFAULT now(),
 lease_until timestamptz, delivered_at timestamptz, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX operations_alert_due ON operations_alert_outbox(state,next_attempt_at);
