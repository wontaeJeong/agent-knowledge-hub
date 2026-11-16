-- Authority derives only from transition-time evidence, never today's FK rows.
CREATE TABLE legacy_compat_memberships (
 workspace_id text NOT NULL REFERENCES workspaces(id), principal_id text NOT NULL REFERENCES access_principals(id),
 role text NOT NULL CHECK(role IN ('reader','editor','reviewer')), subject text NOT NULL,
 revoked boolean NOT NULL DEFAULT false, captured_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(workspace_id,principal_id)
);
DO $capture$
BEGIN
 IF to_regclass('pg_temp.legacy_preupgrade_memberships') IS NOT NULL THEN
  INSERT INTO legacy_compat_memberships(workspace_id,principal_id,role,subject)
   SELECT e.workspace_id,e.principal_id,e.role,e.subject FROM legacy_preupgrade_memberships e
   JOIN memberships m ON m.workspace_id=e.workspace_id AND m.principal_id=e.principal_id AND m.role=e.role
   JOIN access_principals p ON p.id=e.principal_id AND p.active AND p.kind='human'
   WHERE NOT EXISTS(SELECT 1 FROM access_spaces s WHERE s.workspace_id=e.workspace_id);
 END IF;
END $capture$;
CREATE FUNCTION legacy_compat_revoke_membership() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' OR NEW.role IS DISTINCT FROM OLD.role OR NEW.workspace_id IS DISTINCT FROM OLD.workspace_id OR NEW.principal_id IS DISTINCT FROM OLD.principal_id THEN
  UPDATE legacy_compat_memberships SET revoked=true WHERE workspace_id=OLD.workspace_id AND principal_id=OLD.principal_id;
 END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER legacy_compat_membership_revoke AFTER UPDATE OR DELETE ON memberships FOR EACH ROW EXECUTE FUNCTION legacy_compat_revoke_membership();
CREATE FUNCTION legacy_compat_adopted() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 UPDATE legacy_compat_memberships SET revoked=true WHERE workspace_id=NEW.workspace_id;
 RETURN NEW;
END $$;
CREATE TRIGGER legacy_compat_adoption_revoke AFTER INSERT ON access_spaces FOR EACH ROW EXECUTE FUNCTION legacy_compat_adopted();
-- Session-bound internal execution grants may reference an unadopted workspace.
-- External credentials still require current canonical capability and scope.
ALTER TABLE access_credentials DROP CONSTRAINT access_credentials_workspace_id_fkey;
ALTER TABLE access_credentials ADD CONSTRAINT access_credentials_workspace_id_fkey FOREIGN KEY(workspace_id) REFERENCES workspaces(id);
-- A random non-secret installation binding prevents replay of an operator's signed manifest in another DB.
CREATE TABLE legacy_compat_installation (
 singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton), installation_id uuid NOT NULL DEFAULT gen_random_uuid(),
 import_key_fingerprint text
);
INSERT INTO legacy_compat_installation(singleton) VALUES(true);
CREATE TABLE legacy_compat_manifest_imports (
 manifest_hash text PRIMARY KEY, backup_hash text NOT NULL, key_fingerprint text NOT NULL,
 captured_at timestamptz NOT NULL, issued_at timestamptz NOT NULL, imported_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
-- OIDC group role only narrows an evidenced legacy binding during this live session.
ALTER TABLE runtime_sessions ADD COLUMN legacy_role_ceiling text CHECK(legacy_role_ceiling IN ('reader','editor','reviewer'));
ALTER TABLE runtime_sessions ADD COLUMN legacy_verified_at timestamptz;
