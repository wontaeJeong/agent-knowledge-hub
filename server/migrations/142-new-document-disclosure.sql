-- Immutable requested manual snapshots; no import_run or private draft read grant.
CREATE TABLE workflow_draft_disclosures (
 workspace_id text NOT NULL REFERENCES workspaces(id), id text NOT NULL,
 owner_id text NOT NULL, draft_id text NOT NULL, draft_revision integer NOT NULL CHECK(draft_revision>0),
 content_hash text NOT NULL, snapshot jsonb NOT NULL, dependency_envelope jsonb NOT NULL,
 parent_id text, policy_hash text NOT NULL, audience jsonb NOT NULL, reviewer_id text NOT NULL,
 policy_mode text NOT NULL CHECK(policy_mode IN ('personal-owner','independent-review')),
 status text NOT NULL CHECK(status IN ('pending','pending-confirmation','approved','rejected')),
 revision integer NOT NULL DEFAULT 1, hash text NOT NULL,
 request_mutation_id uuid NOT NULL, request_hash text NOT NULL,
 decisions jsonb NOT NULL DEFAULT '{}', source_id text, batch_id text, submission jsonb,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(workspace_id,id), UNIQUE(workspace_id,owner_id,request_mutation_id)
);
CREATE UNIQUE INDEX workflow_new_document_once ON workflow_draft_disclosures(workspace_id,owner_id,draft_id) WHERE batch_id IS NOT NULL;
CREATE INDEX workflow_draft_disclosure_owner ON workflow_draft_disclosures(workspace_id,owner_id,created_at DESC);
CREATE INDEX workflow_draft_disclosure_reviewer ON workflow_draft_disclosures(workspace_id,reviewer_id,created_at DESC);
CREATE UNIQUE INDEX workflow_new_document_mutation ON workflow_draft_disclosures(workspace_id,owner_id,(submission->>'mutationId')) WHERE submission IS NOT NULL;
