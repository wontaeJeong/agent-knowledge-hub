-- Fixed, explicitly consented human operation. Never part of durable agent jobs.
CREATE TABLE scheduled_publications (
 workspace_id text NOT NULL REFERENCES workspaces(id),
 id text PRIMARY KEY,
 batch_id text NOT NULL,
 hash text NOT NULL CHECK(hash ~ '^[a-f0-9]{64}$'),
 principal_id text NOT NULL,
 session_id text CHECK(session_id ~ '^[a-f0-9]{64}$'),
 grant_role text NOT NULL CHECK(grant_role='reviewer'),
 grant_expires_at timestamptz NOT NULL,
 due_at timestamptz NOT NULL,
 request_key text NOT NULL,
 request_hash text NOT NULL,
 status text NOT NULL DEFAULT 'scheduled' CHECK(status IN('scheduled','published','cancelled','failed')),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 finished_at timestamptz,
 result jsonb,
 error_code text,
 FOREIGN KEY(workspace_id,batch_id) REFERENCES batches(workspace_id,id),
 UNIQUE(workspace_id,principal_id,request_key)
);
CREATE UNIQUE INDEX scheduled_publication_active_batch ON scheduled_publications(workspace_id,batch_id) WHERE status='scheduled';
CREATE INDEX scheduled_publication_due ON scheduled_publications(due_at) WHERE status='scheduled';
