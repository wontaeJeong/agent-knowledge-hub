-- Accepted work uses the existing fenced queue; preview expiry does not extend session authority.
ALTER TABLE runtime_execution_grants DROP CONSTRAINT runtime_execution_grants_operation_check;
ALTER TABLE runtime_execution_grants ADD CONSTRAINT runtime_execution_grants_operation_check CHECK(operation IN ('ingest','query','lint','index','bulk'));
CREATE TABLE workflow_bulk_requests (
 workspace_id text NOT NULL REFERENCES workspaces(id), id text NOT NULL,
 principal_id text NOT NULL, session_id text NOT NULL, token_hash text NOT NULL,
 mutation_id text, job_id text, input_hash text NOT NULL, reason text NOT NULL,
 expires_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(workspace_id,id), UNIQUE(workspace_id,principal_id,mutation_id)
);
CREATE TABLE workflow_bulk_items (
 workspace_id text NOT NULL, request_id text NOT NULL, page_id text NOT NULL,
 ordinal integer NOT NULL, patch jsonb NOT NULL, baseline_hash text,
 source_ids text[] NOT NULL DEFAULT '{}', page_ids text[] NOT NULL DEFAULT '{}',
 status text NOT NULL CHECK(status IN ('pending','applied','needs-review','denied','stale','failed')),
 result jsonb NOT NULL DEFAULT '{}',
 PRIMARY KEY(workspace_id,request_id,page_id),
 FOREIGN KEY(workspace_id,request_id) REFERENCES workflow_bulk_requests(workspace_id,id) ON DELETE CASCADE
);
