-- Personal state extends the existing notification store and event outbox.
ALTER TABLE workflow_notifications ADD COLUMN sequence bigint;
ALTER TABLE workflow_notifications ADD COLUMN revision integer NOT NULL DEFAULT 1;
ALTER TABLE workflow_notifications ADD COLUMN state_revision bigint NOT NULL DEFAULT 0;
ALTER TABLE workflow_notifications ADD COLUMN archived_at timestamptz;
ALTER TABLE workflow_notifications ADD COLUMN event_key text;
ALTER TABLE workflow_notifications ADD COLUMN target_kind text;
ALTER TABLE workflow_notifications ADD COLUMN target_id text;
CREATE TABLE collaboration_inbox_state (
 workspace_id text NOT NULL REFERENCES workspaces(id), principal_id text NOT NULL,
 next_sequence bigint NOT NULL DEFAULT 0, revision bigint NOT NULL DEFAULT 0,
 PRIMARY KEY(workspace_id,principal_id)
);
CREATE TABLE collaboration_inbox_mutations (
 workspace_id text NOT NULL REFERENCES workspaces(id), principal_id text NOT NULL, mutation_id text NOT NULL,
 payload_hash text NOT NULL, visibility_hash text, updated integer NOT NULL DEFAULT 0, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(workspace_id,principal_id,mutation_id)
);
CREATE FUNCTION collaboration_inbox_assign() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE s collaboration_inbox_state;
BEGIN
 INSERT INTO collaboration_inbox_state(workspace_id,principal_id) VALUES(NEW.workspace_id,NEW.principal_id) ON CONFLICT DO NOTHING;
 SELECT * INTO s FROM collaboration_inbox_state WHERE workspace_id=NEW.workspace_id AND principal_id=NEW.principal_id FOR UPDATE;
 IF NEW.sequence IS NULL THEN
  UPDATE collaboration_inbox_state SET next_sequence=next_sequence+1,revision=revision+1 WHERE workspace_id=NEW.workspace_id AND principal_id=NEW.principal_id RETURNING * INTO s;
  NEW.sequence:=s.next_sequence; NEW.state_revision:=s.revision;
 ELSIF TG_OP='UPDATE' THEN
  IF NEW.read_at IS DISTINCT FROM OLD.read_at OR NEW.archived_at IS DISTINCT FROM OLD.archived_at THEN
   UPDATE collaboration_inbox_state SET revision=revision+1 WHERE workspace_id=NEW.workspace_id AND principal_id=NEW.principal_id RETURNING * INTO s;
   NEW.revision:=OLD.revision+1; NEW.state_revision:=s.revision;
  END IF;
 END IF;
 NEW.event_key:=coalesce(NEW.event_key,NEW.data->>'eventId',NEW.id);
 NEW.target_kind:=coalesce(NEW.target_kind,CASE WHEN NEW.kind='comment' THEN 'comment' WHEN NEW.kind IN ('job-failure','job-success') THEN 'job' WHEN NEW.kind IN ('change-review-request','change-review-decision') THEN 'review' WHEN NEW.kind='access-decision' THEN 'access-request' ELSE 'document' END);
 NEW.target_id:=coalesce(NEW.target_id,CASE WHEN NEW.target_kind='document' THEN NEW.page_id WHEN NEW.target_kind='comment' THEN NEW.data->>'commentId' ELSE (SELECT resource_id FROM collaboration_events WHERE workspace_id=NEW.workspace_id AND id=NEW.data->>'eventId') END,NEW.page_id);
 RETURN NEW;
END $$;
CREATE TRIGGER workflow_inbox_assign BEFORE INSERT OR UPDATE ON workflow_notifications FOR EACH ROW EXECUTE FUNCTION collaboration_inbox_assign();
-- Bounded backfill, stable ordering and recipient lock order; legacy IDs remain dedup keys.
DO $$ DECLARE row record; batch_count integer; BEGIN
 LOOP
  batch_count:=0;
  FOR row IN SELECT workspace_id,id FROM workflow_notifications WHERE sequence IS NULL ORDER BY workspace_id,principal_id,created_at,id LIMIT 500 LOOP
   UPDATE workflow_notifications SET event_key=id WHERE workspace_id=row.workspace_id AND id=row.id;
   batch_count:=batch_count+1;
  END LOOP;
  EXIT WHEN batch_count=0;
 END LOOP;
END $$;
ALTER TABLE workflow_notifications ALTER COLUMN sequence SET NOT NULL;
ALTER TABLE workflow_notifications ALTER COLUMN event_key SET NOT NULL;
CREATE UNIQUE INDEX workflow_inbox_event ON workflow_notifications(workspace_id,principal_id,event_key);
CREATE UNIQUE INDEX workflow_inbox_sequence ON workflow_notifications(workspace_id,principal_id,sequence);
ALTER TABLE collaboration_events DROP CONSTRAINT collaboration_events_kind_check;
ALTER TABLE collaboration_events ADD CONSTRAINT collaboration_events_kind_check CHECK(kind IN ('publication','change-review-request','expiry','job-failure','job-success','change-review-decision','access-decision'));
-- Extend the existing transaction outbox; preserve migration130's staging gate.
CREATE FUNCTION collaboration_capture_outcome() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_TABLE_NAME='durable_jobs' THEN
 IF NEW.status='succeeded' THEN
  INSERT INTO collaboration_events(workspace_id,id,kind,resource_id,revision) VALUES(NEW.workspace_id,'success:'||NEW.id||':'||NEW.attempts,'job-success',NEW.id,NEW.attempts::text) ON CONFLICT DO NOTHING;
 END IF;
 ELSIF TG_TABLE_NAME='batches' THEN
 IF NEW.data->>'status' IN ('approved','rejected') AND NEW.data->>'requestAuthorizationPending' IS DISTINCT FROM 'true' THEN
  INSERT INTO collaboration_events(workspace_id,id,kind,resource_id,revision) VALUES(NEW.workspace_id,'decision:'||NEW.id||':'||NEW.hash||':'||(NEW.data->>'status'),'change-review-decision',NEW.id,NEW.hash||':'||(NEW.data->>'status')) ON CONFLICT DO NOTHING;
 END IF;
 ELSIF TG_TABLE_NAME='workflow_access_requests' THEN
 IF NEW.status IN ('approved','rejected') THEN
  INSERT INTO collaboration_events(workspace_id,id,kind,page_id,resource_id,revision) VALUES(NEW.workspace_id,'access:'||NEW.id||':'||NEW.revision,'access-decision',NEW.resource_id,NEW.id,NEW.revision::text) ON CONFLICT DO NOTHING;
 END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER collaboration_job_outcome AFTER INSERT OR UPDATE ON durable_jobs FOR EACH ROW EXECUTE FUNCTION collaboration_capture_outcome();
CREATE TRIGGER collaboration_review_outcome AFTER INSERT OR UPDATE ON batches FOR EACH ROW EXECUTE FUNCTION collaboration_capture_outcome();
CREATE TRIGGER collaboration_access_outcome AFTER INSERT OR UPDATE ON workflow_access_requests FOR EACH ROW EXECUTE FUNCTION collaboration_capture_outcome();
