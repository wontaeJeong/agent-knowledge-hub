-- Additive metadata only. Legacy 5-value activity INSERTs still use a NULL position.
ALTER TABLE workflow_activity ADD COLUMN position integer CHECK(position>=0);
CREATE TABLE workflow_personal_library_state(
 workspace_id text NOT NULL REFERENCES workspaces(id), principal_id text NOT NULL,
 revision bigint NOT NULL DEFAULT 0 CHECK(revision>=0), PRIMARY KEY(workspace_id,principal_id)
);
CREATE TABLE workflow_personal_library_mutations(
 workspace_id text NOT NULL REFERENCES workspaces(id), principal_id text NOT NULL,
 mutation_id text NOT NULL, payload_hash text NOT NULL, visibility_hash text NOT NULL,
 revision bigint NOT NULL CHECK(revision>=0), created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(workspace_id,principal_id,mutation_id)
);
CREATE INDEX workflow_activity_order ON workflow_activity(workspace_id,principal_id,kind,position,at DESC,page_id);
