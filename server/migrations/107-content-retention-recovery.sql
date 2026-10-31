-- Recovery bindings are NOT login credentials and confer no authorization.
CREATE TABLE workflow_draft_recovery_grants (
 workspace_id text NOT NULL REFERENCES workspaces(id), owner_id text NOT NULL,
 nonce_hash text NOT NULL, binding jsonb NOT NULL, expires_at timestamptz NOT NULL,
 PRIMARY KEY(workspace_id,owner_id,nonce_hash)
);
CREATE INDEX workflow_draft_recovery_grants_expiry ON workflow_draft_recovery_grants(expires_at);
CREATE TABLE workflow_draft_save_mutations (
 workspace_id text NOT NULL REFERENCES workspaces(id), owner_id text NOT NULL,
 mutation_id text NOT NULL, draft_id text NOT NULL, input_hash text NOT NULL,
 result jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(workspace_id,owner_id,mutation_id)
);
CREATE TABLE workflow_draft_revision_history (
 workspace_id text NOT NULL REFERENCES workspaces(id), owner_id text NOT NULL,
 draft_id text NOT NULL, revision integer NOT NULL, data jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(workspace_id,owner_id,draft_id,revision)
);
CREATE TABLE content_retention_policies (
 workspace_id text PRIMARY KEY REFERENCES workspaces(id), revision integer NOT NULL,
 policy jsonb NOT NULL, approved_by text NOT NULL, updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE content_retention_receipts (
 workspace_id text NOT NULL REFERENCES workspaces(id), id text NOT NULL,
 preview_hash text NOT NULL, policy_revision integer NOT NULL,
 status text NOT NULL CHECK(status IN ('completed','blocked','failed')),
 actor text NOT NULL, details jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(workspace_id,id)
);
CREATE TABLE content_retention_holds (
 workspace_id text NOT NULL REFERENCES workspaces(id), content_class text NOT NULL
 CHECK(content_class IN ('drafts','publishedVersions','sourceVersions','runtimeResults')),
 reason text NOT NULL, placed_by text NOT NULL, PRIMARY KEY(workspace_id,content_class)
);
-- Existing independently captured/signed operational recovery ledger includes these
-- non-content retirement records. No broad workspace erasure is performed.
ALTER TABLE operations_erased_artifacts DROP CONSTRAINT operations_erased_artifacts_artifact_kind_check;
ALTER TABLE operations_erased_artifacts ADD CONSTRAINT operations_erased_artifacts_artifact_kind_check
 CHECK(artifact_kind IN ('import','slot','draft'));
