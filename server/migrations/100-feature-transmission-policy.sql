-- SEC-011 / GOV-007 / OPS-005. Missing resource policy is DENY.
CREATE TABLE model_destinations (
 id text PRIMARY KEY, canonical_url text NOT NULL, purposes jsonb NOT NULL,
 classifications jsonb NOT NULL, active boolean NOT NULL DEFAULT false,
 revision integer NOT NULL CHECK(revision>0), fingerprint text NOT NULL
);
CREATE TABLE model_source_policies (
 workspace_id text NOT NULL, source_id text NOT NULL,
 revision integer NOT NULL CHECK(revision>0), classification text NOT NULL,
 grants jsonb NOT NULL DEFAULT '[]',
 PRIMARY KEY(workspace_id,source_id),
 FOREIGN KEY(workspace_id,source_id) REFERENCES sources(workspace_id,id)
);
CREATE TABLE feature_policies (
 workspace_id text NOT NULL REFERENCES workspaces(id), feature text NOT NULL,
 enabled boolean NOT NULL, revision integer NOT NULL CHECK(revision>0),
 PRIMARY KEY(workspace_id,feature)
);
CREATE TABLE policy_events (
 workspace_id text NOT NULL REFERENCES workspaces(id), sequence bigint NOT NULL,
 principal_id text NOT NULL, operation text NOT NULL, target_id text NOT NULL,
 revision integer NOT NULL, data jsonb NOT NULL,
 previous_hash text NOT NULL, hash text NOT NULL, at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(workspace_id,sequence)
);
CREATE FUNCTION deny_policy_event_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'policy events are immutable'; END $$;
CREATE TRIGGER immutable_policy_events BEFORE UPDATE OR DELETE ON policy_events
 FOR EACH ROW EXECUTE FUNCTION deny_policy_event_mutation();
