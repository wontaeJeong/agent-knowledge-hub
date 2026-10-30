CREATE TABLE workflow_drafts (
 workspace_id text NOT NULL REFERENCES workspaces(id), owner_id text NOT NULL, id text NOT NULL,
 revision integer NOT NULL CHECK(revision>0), data jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(workspace_id,owner_id,id)
);
CREATE TABLE workflow_document_state (
 workspace_id text NOT NULL, page_id text NOT NULL, parent_id text,
 state text NOT NULL DEFAULT 'active' CHECK(state IN ('active','archived','trash')),
 revision integer NOT NULL DEFAULT 1, data jsonb NOT NULL DEFAULT '{}',
 PRIMARY KEY(workspace_id,page_id), FOREIGN KEY(workspace_id,page_id) REFERENCES pages(workspace_id,id)
);
CREATE TABLE workflow_source_state (
 workspace_id text NOT NULL, source_id text NOT NULL,
 state text NOT NULL CHECK(state IN ('active','withdrawn','deleted')),
 revision integer NOT NULL DEFAULT 1, data jsonb NOT NULL DEFAULT '{}',
 PRIMARY KEY(workspace_id,source_id), FOREIGN KEY(workspace_id,source_id) REFERENCES sources(workspace_id,id)
);
CREATE TABLE workflow_comments (
 workspace_id text NOT NULL, id text NOT NULL, page_id text NOT NULL, principal_id text NOT NULL,
 revision integer NOT NULL, version integer NOT NULL, anchor text NOT NULL, data jsonb NOT NULL,
 resolved boolean NOT NULL DEFAULT false, deleted boolean NOT NULL DEFAULT false,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(workspace_id,id), FOREIGN KEY(workspace_id,page_id) REFERENCES pages(workspace_id,id)
);
CREATE TABLE workflow_subscriptions (
 workspace_id text NOT NULL, principal_id text NOT NULL, page_id text NOT NULL,
 PRIMARY KEY(workspace_id,principal_id,page_id), FOREIGN KEY(workspace_id,page_id) REFERENCES pages(workspace_id,id)
);
CREATE TABLE workflow_notifications (
 workspace_id text NOT NULL REFERENCES workspaces(id), id text NOT NULL, principal_id text NOT NULL,
 page_id text NOT NULL, version integer, kind text NOT NULL, data jsonb NOT NULL,
 read_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(workspace_id,id)
);
CREATE INDEX workflow_notification_owner ON workflow_notifications(workspace_id,principal_id,created_at DESC);
CREATE TABLE workflow_activity (
 workspace_id text NOT NULL, principal_id text NOT NULL, page_id text NOT NULL, kind text NOT NULL CHECK(kind IN ('favorite','recent')),
 at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(workspace_id,principal_id,page_id,kind)
);
CREATE TABLE workflow_templates (
 workspace_id text NOT NULL REFERENCES workspaces(id), owner_id text NOT NULL, id text NOT NULL,
 revision integer NOT NULL, data jsonb NOT NULL, PRIMARY KEY(workspace_id,owner_id,id)
);
CREATE TABLE workflow_preferences (
 workspace_id text NOT NULL REFERENCES workspaces(id), principal_id text NOT NULL,
 revision integer NOT NULL, data jsonb NOT NULL, PRIMARY KEY(workspace_id,principal_id)
);
CREATE TABLE workflow_access_requests (
 id text PRIMARY KEY, workspace_id text NOT NULL REFERENCES workspaces(id), principal_id text NOT NULL,
 resource_id text NOT NULL, reason text NOT NULL, status text NOT NULL DEFAULT 'pending',
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE workflow_events (
 workspace_id text NOT NULL REFERENCES workspaces(id), id text NOT NULL, principal_id text NOT NULL,
 kind text NOT NULL, resource_id text NOT NULL, data jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(workspace_id,id)
);
