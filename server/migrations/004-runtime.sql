CREATE TABLE runtime_sessions (
 id text PRIMARY KEY, workspace_id text NOT NULL REFERENCES workspaces(id),
 principal_id text NOT NULL, csrf text NOT NULL, subject text NOT NULL,
 access_token text NOT NULL, expires_at timestamptz NOT NULL
);
CREATE TABLE oidc_logins (
 id text PRIMARY KEY, data jsonb NOT NULL, expires_at timestamptz NOT NULL
);
CREATE TABLE runtime_answers (
 workspace_id text NOT NULL REFERENCES workspaces(id), id text NOT NULL,
 principal_id text NOT NULL, data jsonb NOT NULL,
 PRIMARY KEY(workspace_id,id)
);
CREATE TABLE runtime_lints (
 workspace_id text NOT NULL REFERENCES workspaces(id), principal_id text NOT NULL,
 data jsonb NOT NULL, PRIMARY KEY(workspace_id,principal_id)
);
CREATE TABLE runtime_jobs (
 id text PRIMARY KEY, workspace_id text NOT NULL REFERENCES workspaces(id),
 principal_id text NOT NULL, operation text NOT NULL,
 status text NOT NULL CHECK(status IN ('running','succeeded','failed')),
 created_at timestamptz NOT NULL DEFAULT now(), finished_at timestamptz,
 error_code text, result_id text
);
