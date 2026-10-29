CREATE TABLE usage_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id), principal_id text NOT NULL,
  operation text NOT NULL, succeeded boolean NOT NULL,
  duration_ms double precision NOT NULL CHECK(duration_ms >= 0),
  at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX usage_workspace_time ON usage_events(workspace_id, at);
CREATE INDEX usage_principal_time ON usage_events(workspace_id, principal_id, at);
CREATE INDEX audit_workspace_time ON audit(workspace_id, at);
