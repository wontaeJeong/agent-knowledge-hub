-- Reviewed erasure supports private workflow records without weakening normal immutable writes.
CREATE OR REPLACE FUNCTION operations_privileged_product_redaction(target_table text,row_locator tid,replacements jsonb) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE assignment text := ''; item record; trigger_row record; triggers jsonb := '[]'; affected integer; relation regclass;
BEGIN
 IF target_table !~ '^(sources|pages|versions|batches|requests|publications|approvals|workflow_[a-z_]+|runtime_(answers|lints|jobs)|agent_[a-z_]+|refinement_[a-z_]+|durable_(jobs|job_outbox|model_calls)|storage_(imports|import_sources|import_effects|snapshots|attachment_links)|question_(threads|turns|feedback|feedback_work)|version_(metadata|metadata_events|restore_previews|restore_plans|restore_applications)|versions_decisions|model_usage_events|collaboration_[a-z_]+|governance_[a-z_]+)$' THEN RAISE EXCEPTION 'ERASURE_TABLE_NOT_ALLOWED'; END IF;
 relation := to_regclass(format('public.%I',target_table)); IF relation IS NULL OR jsonb_typeof(replacements)<>'object' THEN RAISE EXCEPTION 'ERASURE_INVALID_TARGET'; END IF;
 FOR item IN SELECT j.key,c.data_type FROM jsonb_each(replacements) j JOIN information_schema.columns c ON c.table_schema='public' AND c.table_name=target_table AND c.column_name=j.key LOOP
  IF item.key ~ '^(id|workspace_id|principal_id|owner_id|created_by|recorded_by|reviewed_by|approved_by|actor_id|kind|state|status|operation|role|scope|parent_kind|[a-z_]+_id|[a-z_]+_hash|sha256|mime|provider|model|key|token_hash|mode|category|decision|action|requested_scope|cadence|backend|user_code|document_type|due_cycle|updated_by|applied_by|decision_by|resource_type)$' AND NOT(target_table='model_usage_events' AND item.key IN ('model','deployment_id')) OR (target_table='agent_outcomes' AND item.key='result') THEN RAISE EXCEPTION 'ERASURE_IDENTITY_COLUMN_FORBIDDEN'; END IF;
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
