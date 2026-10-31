-- Responsibility is not authorization. None of these tables grant a space role.
CREATE TABLE governance_business_owners (
  workspace_id text NOT NULL REFERENCES workspaces(id), page_id text NOT NULL,
  revision integer NOT NULL CHECK(revision>0), owner_id text NOT NULL,
  backup_id text NOT NULL CHECK(backup_id<>owner_id), updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(workspace_id,page_id)
);
CREATE TABLE governance_type_policies (
  workspace_id text NOT NULL REFERENCES workspaces(id), document_type text NOT NULL,
  revision integer NOT NULL CHECK(revision>0), required_keys text[] NOT NULL,
  mode text NOT NULL CHECK(mode IN ('warn','block')), cadence_days integer CHECK(cadence_days BETWEEN 1 AND 3650),
  PRIMARY KEY(workspace_id,document_type)
);
CREATE TABLE governance_review_assignments (
  workspace_id text NOT NULL REFERENCES workspaces(id), batch_id text NOT NULL,
  revision integer NOT NULL CHECK(revision>0), batch_hash text NOT NULL,
  assignee_ids text[] NOT NULL, backup_id text NOT NULL, deadline timestamptz NOT NULL,
  absent_ids text[] NOT NULL DEFAULT '{}', updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(workspace_id,batch_id)
);
CREATE TABLE governance_handoffs (
  workspace_id text NOT NULL REFERENCES workspaces(id), page_id text NOT NULL,
  owner_revision integer NOT NULL, owner_id text NOT NULL, backup_id text NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','resolved')),
  work jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(workspace_id,page_id,owner_revision)
);
CREATE TABLE governance_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, workspace_id text NOT NULL REFERENCES workspaces(id),
  kind text NOT NULL, resource_id text NOT NULL, revision integer NOT NULL,
  actor_id text NOT NULL, reason text NOT NULL CHECK(length(trim(reason))>0),
  data jsonb NOT NULL, at timestamptz NOT NULL DEFAULT clock_timestamp()
);
ALTER TABLE workflow_access_requests ADD COLUMN revision integer NOT NULL DEFAULT 1;
ALTER TABLE workflow_access_requests ADD COLUMN resource_type text NOT NULL DEFAULT 'page' CHECK(resource_type IN ('page','space'));
ALTER TABLE workflow_access_requests ADD COLUMN decision_by text;
ALTER TABLE workflow_access_requests ADD COLUMN decision_reason text;
ALTER TABLE workflow_access_requests ADD COLUMN decided_at timestamptz;
