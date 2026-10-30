-- Bounded raw assets live transactionally in PostgreSQL for the initial App1/DB1 release.
-- No new object service or non-durable container filesystem is required.
CREATE TABLE imports (
 workspace_id text NOT NULL REFERENCES workspaces(id), id text NOT NULL,
 principal_id text NOT NULL, title text NOT NULL, revision integer NOT NULL DEFAULT 1,
 status text NOT NULL DEFAULT 'uploading', selection jsonb NOT NULL,
 parsed jsonb, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 request_key text NOT NULL, request_hash text NOT NULL,
 PRIMARY KEY(workspace_id,id), UNIQUE(workspace_id,principal_id,request_key),
 FOREIGN KEY(workspace_id,principal_id) REFERENCES memberships(workspace_id,principal_id)
);
CREATE TABLE import_files (
 workspace_id text NOT NULL, import_id text NOT NULL, id text NOT NULL,
 name text NOT NULL, size integer NOT NULL CHECK(size>0 AND size<=26214400),
 sha256 text NOT NULL, received integer NOT NULL DEFAULT 0,
 PRIMARY KEY(workspace_id,import_id,id),
 FOREIGN KEY(workspace_id,import_id) REFERENCES imports(workspace_id,id) ON DELETE CASCADE
);
CREATE TABLE import_parts (
 workspace_id text NOT NULL, import_id text NOT NULL, file_id text NOT NULL, part integer NOT NULL CHECK(part>=0),
 sha256 text NOT NULL, data bytea NOT NULL CHECK(octet_length(data)<=262144),
 PRIMARY KEY(workspace_id,import_id,file_id,part),
 FOREIGN KEY(workspace_id,import_id,file_id) REFERENCES import_files(workspace_id,import_id,id) ON DELETE CASCADE
);
CREATE TABLE import_runs (
 workspace_id text NOT NULL, id text NOT NULL, import_id text NOT NULL, principal_id text NOT NULL,
 input_revision integer NOT NULL, mode text NOT NULL CHECK(mode IN ('model','offline','preflight')),
 policy_version text NOT NULL DEFAULT 'agent-knowledge-hub/imports/1', execution_config jsonb NOT NULL DEFAULT '{}',
 status text NOT NULL DEFAULT 'queued', stage text NOT NULL DEFAULT 'queued',
 attempt integer NOT NULL DEFAULT 0, calls integer NOT NULL DEFAULT 0,
 lease_token bigint NOT NULL DEFAULT 0, lease_until timestamptz, cancel_requested boolean NOT NULL DEFAULT false,
 session_id text, grant_role text NOT NULL, grant_expires_at timestamptz NOT NULL,
 result jsonb, input_envelope jsonb, state_hash text, error_code text, changeset jsonb,
 request_key text NOT NULL, request_hash text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(workspace_id,id), UNIQUE(workspace_id,principal_id,request_key),
 FOREIGN KEY(workspace_id,import_id) REFERENCES imports(workspace_id,id) ON DELETE CASCADE
);
CREATE INDEX import_runs_pending ON import_runs(status,lease_until,created_at);
CREATE TABLE import_observations (
 workspace_id text NOT NULL, principal_id text NOT NULL, source_key text NOT NULL, content_hash text NOT NULL,
 import_id text NOT NULL, record_id text NOT NULL, event text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(workspace_id,principal_id,source_key,content_hash),
 FOREIGN KEY(workspace_id,import_id) REFERENCES imports(workspace_id,id) ON DELETE CASCADE
);
CREATE TABLE import_disclosures (
 workspace_id text NOT NULL, run_id text NOT NULL, principal_id text NOT NULL, reviewer_id text NOT NULL,
 audience jsonb NOT NULL, hash text NOT NULL, status text NOT NULL DEFAULT 'pending',
 approved_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(workspace_id,run_id),
 FOREIGN KEY(workspace_id,run_id) REFERENCES import_runs(workspace_id,id) ON DELETE CASCADE
);
