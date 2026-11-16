-- Scope follows current canonical page.category. No independent topic authority.
CREATE TABLE collaboration_subscriptions (
 workspace_id text NOT NULL REFERENCES workspaces(id), principal_id text NOT NULL,
 scope text NOT NULL CHECK(scope IN ('space','topic')), target text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(workspace_id,principal_id,scope,target),
 CHECK((scope='space' AND target='') OR (scope='topic' AND length(target) BETWEEN 1 AND 200))
);
ALTER TABLE workflow_subscriptions ADD COLUMN created_at timestamptz NOT NULL DEFAULT clock_timestamp();
ALTER TABLE workflow_notifications ADD COLUMN processed_at timestamptz;
ALTER TABLE workflow_notifications ALTER COLUMN page_id DROP NOT NULL;
-- Identifier-only transaction outbox: never store a title, body or failure text.
CREATE TABLE collaboration_events (
 workspace_id text NOT NULL REFERENCES workspaces(id), id text NOT NULL,
 kind text NOT NULL CHECK(kind IN ('publication','change-review-request','expiry','job-failure')),
 page_id text, version integer, resource_id text NOT NULL, revision text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(), projected_at timestamptz,
 PRIMARY KEY(workspace_id,id)
);
CREATE INDEX collaboration_events_pending ON collaboration_events(created_at,id) WHERE projected_at IS NULL;
CREATE FUNCTION collaboration_capture_event() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE entry record;
BEGIN
 IF TG_TABLE_NAME='publications' THEN
  FOR entry IN SELECT key,value FROM jsonb_each_text(NEW.result->'versions') LOOP
   INSERT INTO collaboration_events(workspace_id,id,kind,page_id,version,resource_id,revision)
   VALUES(NEW.workspace_id,'publication:'||NEW.batch_id||':'||entry.key,'publication',entry.key,entry.value::integer,NEW.batch_id,entry.value) ON CONFLICT DO NOTHING;
  END LOOP;
 ELSIF TG_TABLE_NAME='batches' THEN
  IF NEW.data->>'status'='pending' THEN
   INSERT INTO collaboration_events(workspace_id,id,kind,resource_id,revision)
   VALUES(NEW.workspace_id,'review:'||NEW.id||':'||NEW.hash,'change-review-request',NEW.id,NEW.hash) ON CONFLICT DO NOTHING;
  END IF;
 ELSIF TG_TABLE_NAME='durable_jobs' THEN
  IF NEW.status='dead' THEN
   INSERT INTO collaboration_events(workspace_id,id,kind,resource_id,revision)
   VALUES(NEW.workspace_id,'failure:'||NEW.id||':'||NEW.attempts,'job-failure',NEW.id,NEW.attempts::text) ON CONFLICT DO NOTHING;
  END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER collaboration_publication AFTER INSERT ON publications FOR EACH ROW EXECUTE FUNCTION collaboration_capture_event();
CREATE TRIGGER collaboration_review AFTER INSERT OR UPDATE ON batches FOR EACH ROW EXECUTE FUNCTION collaboration_capture_event();
CREATE TRIGGER collaboration_failure AFTER INSERT OR UPDATE ON durable_jobs FOR EACH ROW EXECUTE FUNCTION collaboration_capture_event();
