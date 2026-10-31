CREATE TABLE access_review_rules (
 workspace_id text REFERENCES access_spaces(workspace_id), document_type text NOT NULL,
 minimum_approvals integer NOT NULL CHECK(minimum_approvals BETWEEN 1 AND 10), reviewer_ids text[] NOT NULL,
 PRIMARY KEY(workspace_id,document_type)
);
CREATE TABLE access_audit (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 principal_id text NOT NULL REFERENCES access_principals(id), operation text NOT NULL,
 workspace_id text REFERENCES workspaces(id), target_id text,
 data jsonb NOT NULL DEFAULT '{}', at timestamptz NOT NULL DEFAULT clock_timestamp()
);
