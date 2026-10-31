-- Stable legal-deletion receipts for private import archives and their staged CAS objects.
-- No original payload, filename, source text or encryption key is stored here.
CREATE TABLE operations_erased_artifacts (
 workspace_id text NOT NULL REFERENCES workspaces(id), artifact_kind text NOT NULL CHECK(artifact_kind IN ('import','slot')),
 artifact_id text NOT NULL, hashes jsonb NOT NULL, preview_hash text NOT NULL, approved_by text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(workspace_id,artifact_kind,artifact_id)
);
