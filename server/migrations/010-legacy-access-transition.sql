-- Apply only AFTER released 006-imports.sql and 007-access.sql, before canonical010.
-- No authority falls back to these archived relations. No raw/source/reader rows are changed.
DO $transition$
DECLARE old_name text; archived text; item record; renamed text;
BEGIN
 IF EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='access_principals' AND column_name='display_name')
 AND NOT EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='access_principals' AND column_name='active') THEN
  -- Preserve verified session subject metadata before010 invalidates originating sessions.
  CREATE TABLE legacy_v1_identity_subjects AS SELECT DISTINCT principal_id,subject FROM runtime_sessions;
  FOREACH old_name IN ARRAY ARRAY['access_principals','access_orgs','access_org_members','access_teams','access_team_members','access_spaces','access_grants','access_invitations','access_reviewers','access_audit','access_triage'] LOOP
   archived='legacy_v1_'||old_name;
   IF to_regclass(old_name) IS NOT NULL THEN
    EXECUTE format('ALTER TABLE %I RENAME TO %I',old_name,archived);
    -- Constraint-backed indexes otherwise retain their old globally scoped names.
    FOR item IN SELECT conname FROM pg_constraint WHERE conrelid=to_regclass(archived) LOOP
     renamed=left('legacy_v1_'||item.conname,48)||'_'||substr(md5(archived||item.conname),1,10);
     EXECUTE format('ALTER TABLE %I RENAME CONSTRAINT %I TO %I',archived,item.conname,renamed);
    END LOOP;
    FOR item IN SELECT c.relname FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid WHERE i.indrelid=to_regclass(archived) AND NOT EXISTS(SELECT 1 FROM pg_constraint k WHERE k.conindid=i.indexrelid) LOOP
     EXECUTE format('ALTER INDEX %I RENAME TO %I',item.relname,left('legacy_v1_'||item.relname,48)||'_'||substr(md5(archived||item.relname),1,10));
    END LOOP;
    FOR item IN SELECT c.relname FROM pg_class c JOIN pg_depend d ON d.objid=c.oid WHERE c.relkind='S' AND d.refobjid=to_regclass(archived) AND d.deptype IN ('a','i') LOOP
     EXECUTE format('ALTER SEQUENCE %I RENAME TO %I',item.relname,left('legacy_v1_'||item.relname,48)||'_'||substr(md5(archived||item.relname),1,10));
    END LOOP;
   END IF;
  END LOOP;
  CREATE TABLE legacy_v1_access_function_definitions(name text PRIMARY KEY,definition text NOT NULL);
  INSERT INTO legacy_v1_access_function_definitions VALUES
   ('access_role',pg_get_functiondef('access_role(text,text)'::regprocedure)),
   ('effective_membership',pg_get_functiondef('effective_membership(text,text)'::regprocedure));
  -- Preserve definitions as inert evidence, not a callable legacy-membership fallback.
  DROP FUNCTION effective_membership(text,text);
  DROP FUNCTION access_role(text,text);
 END IF;
END $transition$;
