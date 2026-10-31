-- Immutable version metadata is captured only at the actual publication boundary.
-- Historical versions without a row are unknown, never backfilled from current settings.
CREATE TABLE version_metadata (
 workspace_id text NOT NULL,page_id text NOT NULL,number integer NOT NULL,
 snapshot jsonb NOT NULL CHECK(octet_length(snapshot::text)<=1048576),snapshot_hash text NOT NULL,anchors jsonb NOT NULL CHECK(octet_length(anchors::text)<=1048576),
 actor_id text NOT NULL,captured_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(workspace_id,page_id,number),
 FOREIGN KEY(workspace_id,page_id,number) REFERENCES versions(workspace_id,page_id,number)
);
CREATE TABLE version_metadata_events (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 workspace_id text NOT NULL,page_id text NOT NULL,actor_id text NOT NULL,
 reason text NOT NULL,before_snapshot jsonb NOT NULL,after_snapshot jsonb NOT NULL,
 at timestamptz NOT NULL DEFAULT clock_timestamp(),
 FOREIGN KEY(workspace_id,page_id) REFERENCES pages(workspace_id,id)
);
CREATE INDEX version_metadata_events_page ON version_metadata_events(workspace_id,page_id,id);
CREATE TABLE versions_decisions (
 id text PRIMARY KEY,workspace_id text NOT NULL,original_batch_id text NOT NULL,original_hash text NOT NULL,
 actor_id text NOT NULL,decision text NOT NULL CHECK(decision IN ('approve','reject')),
 selected_page_ids text[] NOT NULL,reasons jsonb NOT NULL,attribution jsonb NOT NULL,
 derived_batch_id text,derived_hash text,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 FOREIGN KEY(workspace_id,original_batch_id) REFERENCES batches(workspace_id,id),
 FOREIGN KEY(workspace_id,derived_batch_id) REFERENCES batches(workspace_id,id)
);
CREATE TABLE version_restore_previews (
 workspace_id text NOT NULL REFERENCES workspaces(id),principal_id text NOT NULL,hash text NOT NULL,payload jsonb NOT NULL,
 expires_at timestamptz NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(workspace_id,principal_id,hash)
);
CREATE TABLE version_restore_plans (
 workspace_id text NOT NULL,batch_id text NOT NULL,batch_hash text NOT NULL,page_id text NOT NULL,
 plan_hash text NOT NULL,payload jsonb NOT NULL,
 PRIMARY KEY(workspace_id,batch_id,page_id),FOREIGN KEY(workspace_id,batch_id) REFERENCES batches(workspace_id,id)
);
CREATE TABLE version_restore_applications (
 workspace_id text NOT NULL,batch_id text NOT NULL,page_id text NOT NULL,number integer NOT NULL,
 plan_hash text NOT NULL,applied_by text NOT NULL,at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(workspace_id,batch_id,page_id),
 FOREIGN KEY(workspace_id,page_id,number) REFERENCES versions(workspace_id,page_id,number),
 FOREIGN KEY(workspace_id,batch_id,page_id) REFERENCES version_restore_plans(workspace_id,batch_id,page_id)
);
CREATE FUNCTION reject_version_history_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'VERSION_HISTORY_IMMUTABLE'; END $$;
CREATE TRIGGER version_metadata_immutable BEFORE UPDATE OR DELETE ON version_metadata FOR EACH ROW EXECUTE FUNCTION reject_version_history_mutation();
CREATE TRIGGER version_metadata_events_immutable BEFORE UPDATE OR DELETE ON version_metadata_events FOR EACH ROW EXECUTE FUNCTION reject_version_history_mutation();
CREATE TRIGGER versions_decisions_immutable BEFORE UPDATE OR DELETE ON versions_decisions FOR EACH ROW EXECUTE FUNCTION reject_version_history_mutation();
CREATE TRIGGER version_restore_previews_immutable BEFORE UPDATE OR DELETE ON version_restore_previews FOR EACH ROW EXECUTE FUNCTION reject_version_history_mutation();
CREATE TRIGGER version_restore_plans_immutable BEFORE UPDATE OR DELETE ON version_restore_plans FOR EACH ROW EXECUTE FUNCTION reject_version_history_mutation();
CREATE TRIGGER version_restore_applications_immutable BEFORE UPDATE OR DELETE ON version_restore_applications FOR EACH ROW EXECUTE FUNCTION reject_version_history_mutation();
