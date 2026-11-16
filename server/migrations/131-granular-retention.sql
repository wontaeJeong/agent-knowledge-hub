-- Explicit manual artifact selection and independent review. No deletion period/default is introduced.
CREATE TABLE content_retention_plans (
 workspace_id text NOT NULL REFERENCES workspaces(id), id text NOT NULL,
 requested_by text NOT NULL, selection jsonb NOT NULL, preview_hash text NOT NULL,
 policy_revision integer NOT NULL, state text NOT NULL CHECK(state IN ('pending','approved','rejected','executed')),
 reviewed_by text, review_hash text, receipt jsonb, created_at timestamptz NOT NULL DEFAULT now(),
 expires_at timestamptz NOT NULL DEFAULT now()+interval '30 minutes',
 PRIMARY KEY(workspace_id,id), CHECK(reviewed_by IS NULL OR reviewed_by<>requested_by)
);
ALTER TABLE operations_erased_artifacts DROP CONSTRAINT operations_erased_artifacts_artifact_kind_check;
ALTER TABLE operations_erased_artifacts ADD CONSTRAINT operations_erased_artifacts_artifact_kind_check
 CHECK(artifact_kind IN ('import','slot','draft','published-version','source-snapshot','attachment-version','runtime-answer','runtime-job'));
CREATE FUNCTION retention_fence_granular_artifact() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 PERFORM pg_advisory_xact_lock_shared(822025);
 IF TG_TABLE_NAME='runtime_answers' OR TG_TABLE_NAME='runtime_jobs' THEN
  IF EXISTS(SELECT 1 FROM operations_erased_artifacts WHERE workspace_id=NEW.workspace_id AND artifact_kind=CASE TG_TABLE_NAME WHEN 'runtime_answers' THEN 'runtime-answer' ELSE 'runtime-job' END AND artifact_id=NEW.id) THEN RAISE EXCEPTION 'RETENTION_ARTIFACT_RETIRED'; END IF;
 ELSIF TG_TABLE_NAME='storage_blobs' THEN
  IF EXISTS(SELECT 1 FROM operations_erased_artifacts WHERE workspace_id=NEW.workspace_id AND artifact_kind='attachment-version' AND split_part(artifact_id,'/',3)=NEW.id) THEN RAISE EXCEPTION 'RETENTION_ARTIFACT_RETIRED'; END IF;
 ELSIF TG_TABLE_NAME='storage_attachment_versions' THEN
  IF EXISTS(SELECT 1 FROM operations_erased_artifacts WHERE workspace_id=NEW.workspace_id AND artifact_kind='attachment-version' AND (split_part(artifact_id,'/',3)=NEW.blob_id OR split_part(artifact_id,'/',1)=NEW.slot_id AND split_part(artifact_id,'/',2)=NEW.revision::text)) THEN RAISE EXCEPTION 'RETENTION_ARTIFACT_RETIRED'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER retention_retired_answer_fence BEFORE INSERT OR UPDATE ON runtime_answers FOR EACH ROW EXECUTE FUNCTION retention_fence_granular_artifact();
CREATE TRIGGER retention_retired_job_fence BEFORE INSERT OR UPDATE ON runtime_jobs FOR EACH ROW EXECUTE FUNCTION retention_fence_granular_artifact();
CREATE TRIGGER retention_retired_attachment_blob_fence BEFORE INSERT OR UPDATE ON storage_blobs FOR EACH ROW EXECUTE FUNCTION retention_fence_granular_artifact();
CREATE TRIGGER retention_retired_attachment_version_fence BEFORE INSERT OR UPDATE ON storage_attachment_versions FOR EACH ROW EXECUTE FUNCTION retention_fence_granular_artifact();
