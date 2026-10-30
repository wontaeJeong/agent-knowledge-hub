CREATE TABLE storage_blobs (
 workspace_id text NOT NULL REFERENCES workspaces(id), id text NOT NULL,
 parent_kind text NOT NULL CHECK(parent_kind IN ('source','page')), parent_id text NOT NULL,
 sha256 text NOT NULL CHECK(sha256 ~ '^[a-f0-9]{64}$'), size integer NOT NULL CHECK(size BETWEEN 1 AND 5242880),
 mime text NOT NULL, filename text NOT NULL, scan_state text NOT NULL CHECK(scan_state IN ('clean','pending','rejected')),
 created_by text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(workspace_id,id),
 FOREIGN KEY(workspace_id,parent_kind,parent_id) REFERENCES resources(workspace_id,kind,id)
);
CREATE TABLE storage_snapshots (
 workspace_id text NOT NULL REFERENCES workspaces(id), id text NOT NULL, source_id text NOT NULL, blob_id text NOT NULL,
 content_hash text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(workspace_id,id),
 UNIQUE(workspace_id,source_id,content_hash), FOREIGN KEY(workspace_id,blob_id) REFERENCES storage_blobs(workspace_id,id)
);
CREATE TABLE storage_imports (
 workspace_id text NOT NULL REFERENCES workspaces(id), id text NOT NULL, principal_id text NOT NULL, digest text NOT NULL,
 manifest jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(workspace_id,id), UNIQUE(workspace_id,principal_id,digest)
);
CREATE TABLE storage_tickets (
 workspace_id text NOT NULL REFERENCES workspaces(id), token_hash text NOT NULL, blob_id text NOT NULL, principal_id text NOT NULL,
 expires_at timestamptz NOT NULL, revoked boolean NOT NULL DEFAULT false, PRIMARY KEY(workspace_id,token_hash),
 FOREIGN KEY(workspace_id,blob_id) REFERENCES storage_blobs(workspace_id,id)
);
