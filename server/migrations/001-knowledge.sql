CREATE TABLE workspaces (id text PRIMARY KEY);
CREATE TABLE memberships (
  workspace_id text REFERENCES workspaces(id), principal_id text NOT NULL,
  role text NOT NULL CHECK (role IN ('reader','editor','reviewer')),
  PRIMARY KEY(workspace_id, principal_id)
);
CREATE TABLE resources (
  workspace_id text REFERENCES workspaces(id), kind text CHECK(kind IN ('page','source')),
  id text NOT NULL, PRIMARY KEY(workspace_id, kind, id)
);
CREATE TABLE resource_readers (
  workspace_id text, kind text, resource_id text, principal_id text,
  PRIMARY KEY(workspace_id, kind, resource_id, principal_id),
  FOREIGN KEY(workspace_id, kind, resource_id) REFERENCES resources(workspace_id, kind, id),
  FOREIGN KEY(workspace_id, principal_id) REFERENCES memberships(workspace_id, principal_id)
);
CREATE TABLE sources (
  workspace_id text, id text, kind text NOT NULL DEFAULT 'source' CHECK(kind='source'),
  data jsonb NOT NULL, PRIMARY KEY(workspace_id, id),
  FOREIGN KEY(workspace_id, kind, id) REFERENCES resources(workspace_id, kind, id)
);
CREATE TABLE pages (
  workspace_id text, id text, kind text NOT NULL DEFAULT 'page' CHECK(kind='page'),
  data jsonb NOT NULL, PRIMARY KEY(workspace_id, id),
  FOREIGN KEY(workspace_id, kind, id) REFERENCES resources(workspace_id, kind, id)
);
CREATE TABLE versions (
  workspace_id text, page_id text, number integer CHECK(number>0), data jsonb NOT NULL,
  PRIMARY KEY(workspace_id, page_id, number),
  FOREIGN KEY(workspace_id, page_id) REFERENCES pages(workspace_id, id)
);
CREATE TABLE batches (
  workspace_id text REFERENCES workspaces(id), id text, data jsonb NOT NULL,
  hash text NOT NULL, PRIMARY KEY(workspace_id, id)
);
CREATE TABLE approvals (
  workspace_id text, batch_id text, principal_id text, hash text NOT NULL,
  at timestamptz NOT NULL DEFAULT clock_timestamp(), PRIMARY KEY(workspace_id, batch_id),
  FOREIGN KEY(workspace_id, batch_id) REFERENCES batches(workspace_id, id),
  FOREIGN KEY(workspace_id, principal_id) REFERENCES memberships(workspace_id, principal_id)
);
CREATE TABLE publications (
  workspace_id text, batch_id text, result jsonb NOT NULL,
  PRIMARY KEY(workspace_id, batch_id),
  FOREIGN KEY(workspace_id, batch_id) REFERENCES batches(workspace_id, id)
);
CREATE TABLE requests (
  workspace_id text, principal_id text, key text, hash text NOT NULL, result jsonb NOT NULL,
  PRIMARY KEY(workspace_id, principal_id, key),
  FOREIGN KEY(workspace_id, principal_id) REFERENCES memberships(workspace_id, principal_id)
);
CREATE TABLE audit (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  workspace_id text REFERENCES workspaces(id), principal_id text NOT NULL,
  operation text NOT NULL, resource_id text NOT NULL,
  at timestamptz NOT NULL DEFAULT clock_timestamp()
);
