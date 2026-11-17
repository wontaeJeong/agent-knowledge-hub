-- Native PostgreSQL candidate acceleration; authorization stays in canonical search.
CREATE EXTENSION IF NOT EXISTS pg_trgm;
DO $$
DECLARE extension_schema text;
BEGIN
 SELECT n.nspname INTO extension_schema FROM pg_extension e JOIN pg_namespace n ON n.oid=e.extnamespace WHERE e.extname='pg_trgm';
 EXECUTE format('CREATE INDEX versions_content_trgm_idx ON versions USING gin (lower(data->>%L) %I.gin_trgm_ops)','content',extension_schema);
END $$;
CREATE TABLE search_index_state (
 id text PRIMARY KEY CHECK(id='versions-content-v1'),
 last_attempt_at timestamptz,
 last_success_at timestamptz NOT NULL,
 last_success_kind text NOT NULL CHECK(last_success_kind IN ('migration','rebuild')),
 last_success_job_id text,
 last_failure_at timestamptz,
 last_failure_code text,
 last_failure_job_id text
);
INSERT INTO search_index_state(id,last_success_at,last_success_kind) VALUES('versions-content-v1',clock_timestamp(),'migration');
CREATE TABLE search_index_workspace_state (
 workspace_id text PRIMARY KEY REFERENCES workspaces(id),
 observed_mutation_at timestamptz NOT NULL,
 revision bigint NOT NULL CHECK(revision>0)
);
INSERT INTO search_index_workspace_state SELECT workspace_id,clock_timestamp(),1 FROM versions GROUP BY workspace_id;
CREATE FUNCTION observe_search_index_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE affected text;
BEGIN
 affected := CASE WHEN TG_OP='DELETE' THEN OLD.workspace_id ELSE NEW.workspace_id END;
 INSERT INTO search_index_workspace_state VALUES(affected,clock_timestamp(),1)
 ON CONFLICT(workspace_id) DO UPDATE SET observed_mutation_at=excluded.observed_mutation_at,revision=search_index_workspace_state.revision+1;
 IF TG_OP='UPDATE' AND OLD.workspace_id IS DISTINCT FROM NEW.workspace_id THEN
  INSERT INTO search_index_workspace_state VALUES(OLD.workspace_id,clock_timestamp(),1)
  ON CONFLICT(workspace_id) DO UPDATE SET observed_mutation_at=excluded.observed_mutation_at,revision=search_index_workspace_state.revision+1;
 END IF;
 RETURN NULL;
END $$;
CREATE TRIGGER observe_search_index_mutation AFTER INSERT OR UPDATE OR DELETE ON versions FOR EACH ROW EXECUTE FUNCTION observe_search_index_mutation();
ALTER TABLE runtime_execution_grants DROP CONSTRAINT runtime_execution_grants_operation_check;
ALTER TABLE runtime_execution_grants ADD CONSTRAINT runtime_execution_grants_operation_check CHECK(operation IN ('ingest','query','lint','index'));
