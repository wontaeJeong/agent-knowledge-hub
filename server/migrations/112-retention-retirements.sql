-- Retire exact immutable versions; no authority, ACL or body is stored in the ledger.
ALTER TABLE operations_erased_artifacts DROP CONSTRAINT operations_erased_artifacts_artifact_kind_check;
ALTER TABLE operations_erased_artifacts ADD CONSTRAINT operations_erased_artifacts_artifact_kind_check
 CHECK(artifact_kind IN ('import','slot','draft','published-version','source-snapshot'));
CREATE FUNCTION retention_fence_retired_version() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 PERFORM pg_advisory_xact_lock_shared(822025);
 IF EXISTS (SELECT 1 FROM operations_erased_artifacts WHERE workspace_id=NEW.workspace_id AND artifact_kind='published-version' AND artifact_id=NEW.page_id||'/'||NEW.number::text) THEN
  RAISE EXCEPTION 'RETENTION_VERSION_RETIRED';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER retention_retired_version_fence BEFORE INSERT OR UPDATE ON versions FOR EACH ROW EXECUTE FUNCTION retention_fence_retired_version();
CREATE FUNCTION retention_fence_retired_snapshot() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE source_key text; hash_key text;
BEGIN
 PERFORM pg_advisory_xact_lock_shared(822025);
 IF TG_TABLE_NAME='storage_blobs' THEN
  IF NEW.parent_kind<>'source' THEN RETURN NEW; END IF;
  source_key:=NEW.parent_id; hash_key:=NEW.sha256;
 ELSE source_key:=NEW.source_id; hash_key:=NEW.content_hash; END IF;
 IF EXISTS (SELECT 1 FROM operations_erased_artifacts WHERE workspace_id=NEW.workspace_id AND artifact_kind='source-snapshot' AND artifact_id=source_key||'/'||hash_key) THEN
  RAISE EXCEPTION 'RETENTION_SNAPSHOT_RETIRED';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER retention_retired_source_blob_fence BEFORE INSERT OR UPDATE ON storage_blobs FOR EACH ROW EXECUTE FUNCTION retention_fence_retired_snapshot();
CREATE TRIGGER retention_retired_snapshot_fence BEFORE INSERT OR UPDATE ON storage_snapshots FOR EACH ROW EXECUTE FUNCTION retention_fence_retired_snapshot();
