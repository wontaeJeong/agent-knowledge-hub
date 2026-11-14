-- Approved host bindings contain no endpoint token, artifact or personal content.
CREATE TABLE storage_collector_connections (
 workspace_id text NOT NULL REFERENCES workspaces(id),
 id text NOT NULL,
 principal_id text NOT NULL REFERENCES access_principals(id),
 configuration_hash text NOT NULL CHECK (configuration_hash ~ '^[a-f0-9]{64}$'),
 active boolean NOT NULL DEFAULT true,
 revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY (workspace_id,id)
);
