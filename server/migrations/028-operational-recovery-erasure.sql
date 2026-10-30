CREATE TABLE operations_audit_archives (
 workspace_id text NOT NULL REFERENCES workspaces(id), id text NOT NULL,
 first_sequence bigint NOT NULL, last_sequence bigint NOT NULL, previous_hash text NOT NULL, head_hash text NOT NULL,
 target_name text NOT NULL, encrypted_hash text NOT NULL, archived_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(workspace_id,id), UNIQUE(workspace_id,last_sequence)
);
CREATE TABLE operations_recovery_releases (
 id text PRIMARY KEY, backup_id text NOT NULL, source_database text NOT NULL, source_system_identifier text NOT NULL,
 policy_hash text NOT NULL, preview_hash text NOT NULL, operator_id text NOT NULL, status text NOT NULL CHECK(status IN ('previewed','released','failed')),
 created_at timestamptz NOT NULL DEFAULT now(), released_at timestamptz
);
CREATE TABLE operations_recovery_acl (
 workspace_id text NOT NULL REFERENCES workspaces(id), kind text NOT NULL, resource_id text NOT NULL, principal_id text NOT NULL,
 PRIMARY KEY(workspace_id,kind,resource_id,principal_id)
);
CREATE TABLE operations_legal_holds (
 -- Legal hold metadata contains no original content.
 workspace_id text NOT NULL REFERENCES workspaces(id), id text NOT NULL, resource_kind text NOT NULL CHECK(resource_kind IN ('source','page','workspace')),
 resource_id text NOT NULL, active boolean NOT NULL DEFAULT true, placed_by text NOT NULL, placed_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(workspace_id,id)
);
CREATE TABLE operations_erasure_receipts (
 workspace_id text NOT NULL REFERENCES workspaces(id), id text NOT NULL, preview_hash text NOT NULL,
 scope text NOT NULL CHECK(scope IN ('resource','workspace')), resource_kind text, resource_id text, approved_by text NOT NULL,
 status text NOT NULL CHECK(status IN ('completed','failed','blocked')), counts jsonb NOT NULL, error_code text,
 created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(workspace_id,id)
);
-- Only a separately granted privileged operator may invoke this explicit redaction operation.
-- No arbitrary SQL, identifiers, key columns or operation/audit receipts are accepted.
CREATE FUNCTION operations_privileged_product_redaction(target_table text,row_locator tid,replacements jsonb) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE assignment text := ''; item record; trigger_row record; triggers jsonb := '[]'; affected integer; relation regclass;
BEGIN
 IF target_table !~ '^(sources|pages|versions|batches|requests|publications|approvals|workflow_[a-z_]+|runtime_(answers|lints|jobs)|agent_[a-z_]+|refinement_[a-z_]+|durable_(jobs|job_outbox|model_calls)|storage_(imports|import_sources|import_effects|snapshots|attachment_links))$' THEN RAISE EXCEPTION 'ERASURE_TABLE_NOT_ALLOWED'; END IF;
 relation := to_regclass(format('public.%I',target_table)); IF relation IS NULL OR jsonb_typeof(replacements)<>'object' THEN RAISE EXCEPTION 'ERASURE_INVALID_TARGET'; END IF;
 FOR item IN SELECT j.key,c.data_type FROM jsonb_each(replacements) j JOIN information_schema.columns c ON c.table_schema='public' AND c.table_name=target_table AND c.column_name=j.key LOOP
  IF item.key ~ '^(id|workspace_id|principal_id|owner_id|created_by|recorded_by|reviewed_by|approved_by|actor_id|kind|state|status|operation|role|scope|parent_kind|[a-z_]+_id|[a-z_]+_hash|sha256|mime|provider|model|key|token_hash)$' THEN RAISE EXCEPTION 'ERASURE_IDENTITY_COLUMN_FORBIDDEN'; END IF;
  IF item.data_type IN ('json','jsonb') THEN assignment:=assignment||CASE WHEN assignment='' THEN '' ELSE ',' END||format('%I=($2->%L)::%s',item.key,item.key,item.data_type);
  ELSIF item.data_type IN ('text','character varying') THEN assignment:=assignment||CASE WHEN assignment='' THEN '' ELSE ',' END||format('%I=$2->>%L',item.key,item.key);
  ELSE RAISE EXCEPTION 'ERASURE_COLUMN_NOT_ALLOWED'; END IF;
 END LOOP;
 IF assignment='' THEN RAISE EXCEPTION 'ERASURE_NO_CONTENT_COLUMNS'; END IF;
 EXECUTE format('LOCK TABLE %s IN ACCESS EXCLUSIVE MODE',relation);
 FOR trigger_row IN SELECT tgname,tgenabled FROM pg_trigger WHERE tgrelid=relation AND NOT tgisinternal AND tgenabled<>'D' LOOP
  triggers:=triggers||jsonb_build_array(jsonb_build_object('name',trigger_row.tgname,'state',trigger_row.tgenabled));
  EXECUTE format('ALTER TABLE %s DISABLE TRIGGER %I',relation,trigger_row.tgname);
 END LOOP;
 EXECUTE format('UPDATE %s SET %s WHERE ctid=$1',relation,assignment) USING row_locator,replacements;
 GET DIAGNOSTICS affected=ROW_COUNT; IF affected<>1 THEN RAISE EXCEPTION 'ERASURE_PREVIEW_STALE'; END IF;
 FOR trigger_row IN SELECT value->>'name' AS name,value->>'state' AS state FROM jsonb_array_elements(triggers) LOOP
  EXECUTE format('ALTER TABLE %s ENABLE %s TRIGGER %I',relation,CASE trigger_row.state WHEN 'A' THEN 'ALWAYS' WHEN 'R' THEN 'REPLICA' ELSE '' END,trigger_row.name);
 END LOOP;
END $$;
REVOKE ALL ON FUNCTION operations_privileged_product_redaction(text,tid,jsonb) FROM PUBLIC;
