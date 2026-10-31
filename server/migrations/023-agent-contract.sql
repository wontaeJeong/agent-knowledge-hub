CREATE TABLE agent_requests (
 workspace_id text NOT NULL REFERENCES workspaces(id), principal_id text NOT NULL,
 operation text NOT NULL, key text NOT NULL, fingerprint text NOT NULL,
 result jsonb NOT NULL, resources jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(workspace_id,principal_id,operation,key)
);
CREATE TABLE agent_personal_pages (
 workspace_id text NOT NULL REFERENCES workspaces(id), owner_id text NOT NULL, id text NOT NULL,
 revision integer NOT NULL CHECK(revision>0), data jsonb NOT NULL,
 updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(workspace_id,owner_id,id)
);
CREATE TABLE agent_personal_revisions (
 workspace_id text NOT NULL REFERENCES workspaces(id), owner_id text NOT NULL, page_id text NOT NULL,
 revision integer NOT NULL CHECK(revision>0), data jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(workspace_id,owner_id,page_id,revision)
);
CREATE TABLE agent_outcomes (
 workspace_id text NOT NULL REFERENCES workspaces(id), id text NOT NULL, principal_id text NOT NULL,
 result text NOT NULL CHECK(result IN ('success','failure','unknown')),
 status text NOT NULL CHECK(status IN ('needs_review','reviewed','rejected')) DEFAULT 'needs_review',
 data jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(workspace_id,id)
);
CREATE TABLE agent_review_signals (
 workspace_id text NOT NULL REFERENCES workspaces(id), id text NOT NULL, page_id text NOT NULL,
 outcome_id text NOT NULL, state text NOT NULL DEFAULT 'pending',
 created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(workspace_id,id),
 FOREIGN KEY(workspace_id,outcome_id) REFERENCES agent_outcomes(workspace_id,id)
);
