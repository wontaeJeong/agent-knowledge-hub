-- Additive correction: migration 120 is already applied and remains immutable.
-- The outbox and release share one transaction. A legacy prematurely consumed
-- event gets the actual release time, while retaining its stable deduplication ID.
CREATE OR REPLACE FUNCTION collaboration_capture_event() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE entry record; authorization_released boolean := false;
BEGIN
 IF TG_TABLE_NAME='publications' THEN
  FOR entry IN SELECT key,value FROM jsonb_each_text(NEW.result->'versions') LOOP
   INSERT INTO collaboration_events(workspace_id,id,kind,page_id,version,resource_id,revision)
   VALUES(NEW.workspace_id,'publication:'||NEW.batch_id||':'||entry.key,'publication',entry.key,entry.value::integer,NEW.batch_id,entry.value) ON CONFLICT DO NOTHING;
  END LOOP;
 ELSIF TG_TABLE_NAME='batches' THEN
  IF NEW.data->>'status'='pending' AND NEW.data->>'requestAuthorizationPending' IS DISTINCT FROM 'true' THEN
   IF TG_OP='UPDATE' THEN
    authorization_released := OLD.data->>'requestAuthorizationPending'='true';
   END IF;
   INSERT INTO collaboration_events(workspace_id,id,kind,resource_id,revision)
   VALUES(NEW.workspace_id,'review:'||NEW.id||':'||NEW.hash,'change-review-request',NEW.id,NEW.hash)
   ON CONFLICT (workspace_id,id) DO UPDATE
    SET projected_at=NULL,created_at=EXCLUDED.created_at
    WHERE authorization_released;
  END IF;
 ELSIF TG_TABLE_NAME='durable_jobs' THEN
  IF NEW.status='dead' THEN
   INSERT INTO collaboration_events(workspace_id,id,kind,resource_id,revision)
   VALUES(NEW.workspace_id,'failure:'||NEW.id||':'||NEW.attempts,'job-failure',NEW.id,NEW.attempts::text) ON CONFLICT DO NOTHING;
  END IF;
 END IF;
 RETURN NEW;
END $$;

-- One-time conservative repair for releases completed by the old trigger.
-- Historical staging/release times are not recoverable. Requeue only existing
-- current pending model-review events with no notices; retain their original
-- subscription cutoff, and let the canonical live recipient gate decide fanout.
-- Never invent events, timestamps, or notices for historical/staged revisions.
UPDATE collaboration_events e SET projected_at=NULL
FROM batches b
WHERE e.workspace_id=b.workspace_id AND e.resource_id=b.id
 AND e.kind='change-review-request' AND e.revision=b.hash
 AND e.id='review:'||b.id||':'||b.hash
 AND e.projected_at IS NOT NULL
 AND b.data->>'status'='pending' AND b.data->>'mode'='model'
 AND b.data->>'requestAuthorizationPending' IS DISTINCT FROM 'true'
 AND NOT EXISTS (
  SELECT 1 FROM workflow_notifications n
  WHERE n.workspace_id=e.workspace_id AND n.kind='change-review-request'
   AND n.data->>'eventId'=e.id
 );
