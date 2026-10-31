CREATE TABLE runtime_request_traces (
 request_id text PRIMARY KEY,
 workspace_id text NOT NULL REFERENCES workspaces(id),
 principal_id text NOT NULL,
 operation text NOT NULL,
 job_id text NOT NULL REFERENCES durable_jobs(id),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CHECK(request_id ~ '^[a-zA-Z0-9_-]{1,100}$')
);
CREATE INDEX runtime_request_traces_actor ON runtime_request_traces(workspace_id,principal_id,created_at DESC);
