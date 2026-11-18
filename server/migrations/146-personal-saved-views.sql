CREATE TABLE personal_saved_views (
 workspace_id text NOT NULL REFERENCES workspaces(id),
 owner_id text NOT NULL,
 id uuid NOT NULL,
 name text NOT NULL CHECK(char_length(name) BETWEEN 1 AND 100),
 filters jsonb NOT NULL CHECK(jsonb_typeof(filters)='object'),
 position integer NOT NULL CHECK(position>=0),
 revision integer NOT NULL CHECK(revision>0),
 PRIMARY KEY(workspace_id,owner_id,id)
);
CREATE INDEX personal_saved_views_order ON personal_saved_views(workspace_id,owner_id,position,id);
-- The replay record deliberately stores neither the query nor the response definition.
CREATE TABLE personal_saved_view_mutations (
 workspace_id text NOT NULL REFERENCES workspaces(id),
 owner_id text NOT NULL,
 mutation_id uuid NOT NULL,
 payload_hash text NOT NULL,
 view_id uuid NOT NULL,
 revision integer NOT NULL,
 PRIMARY KEY(workspace_id,owner_id,mutation_id)
);
