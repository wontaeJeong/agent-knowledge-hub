-- Identity operations are additive; bearer material stays in runtime_sessions only.
CREATE TABLE identity_session_activity (
 session_id text PRIMARY KEY REFERENCES runtime_sessions(id) ON DELETE CASCADE,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 last_seen_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CHECK(last_seen_at>=created_at)
);
INSERT INTO identity_session_activity(session_id) SELECT id FROM runtime_sessions;
CREATE TABLE identity_events (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 at timestamptz NOT NULL DEFAULT clock_timestamp(), actor_id text NOT NULL,
 operation text NOT NULL, target_id text NOT NULL, data jsonb NOT NULL DEFAULT '{}'
);
CREATE FUNCTION identity_immutable_event() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'IDENTITY_AUDIT_APPEND_ONLY'; END $$;
CREATE TRIGGER identity_event_immutable BEFORE UPDATE OR DELETE ON identity_events
 FOR EACH ROW EXECUTE FUNCTION identity_immutable_event();
CREATE TABLE identity_directory_bindings (
 id text PRIMARY KEY, issuer text NOT NULL, external_group_id text NOT NULL,
 group_id text NOT NULL REFERENCES access_groups(id), revision integer NOT NULL DEFAULT 1,
 active boolean NOT NULL DEFAULT true, approved_by text NOT NULL,
 UNIQUE(issuer,external_group_id,group_id)
);
CREATE TABLE identity_directory_proofs (
 principal_id text NOT NULL REFERENCES access_principals(id), issuer text NOT NULL,
 verified_at timestamptz NOT NULL, valid_until timestamptz NOT NULL,
 PRIMARY KEY(principal_id,issuer), CHECK(valid_until>verified_at)
);
CREATE TABLE identity_directory_edges (
 binding_id text REFERENCES identity_directory_bindings(id),
 principal_id text REFERENCES access_principals(id), binding_revision integer NOT NULL,
 valid_until timestamptz NOT NULL, PRIMARY KEY(binding_id,principal_id)
);
CREATE TABLE identity_manual_group_members (
 group_id text REFERENCES access_groups(id), principal_id text REFERENCES access_principals(id),
 PRIMARY KEY(group_id,principal_id)
);
CREATE TABLE identity_group_denies (
 group_id text REFERENCES access_groups(id), principal_id text REFERENCES access_principals(id),
 at timestamptz NOT NULL DEFAULT clock_timestamp(), PRIMARY KEY(group_id,principal_id)
);
INSERT INTO identity_manual_group_members SELECT * FROM access_group_members;
-- Existing product group mutations retain their manual provenance. An explicit
-- product removal is a tombstone, even when the membership came from directory.
CREATE FUNCTION identity_group_manual_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF current_setting('akh.identity_projection',true)='on' THEN RETURN NULL; END IF;
 IF TG_OP='DELETE' THEN
  DELETE FROM identity_manual_group_members WHERE group_id=OLD.group_id AND principal_id=OLD.principal_id;
  INSERT INTO identity_group_denies(group_id,principal_id) VALUES(OLD.group_id,OLD.principal_id) ON CONFLICT DO NOTHING;
 ELSE
  INSERT INTO identity_manual_group_members VALUES(NEW.group_id,NEW.principal_id) ON CONFLICT DO NOTHING;
 END IF;
 RETURN NULL;
END $$;
CREATE TRIGGER identity_group_manual_change AFTER INSERT OR DELETE ON access_group_members
 FOR EACH ROW EXECUTE FUNCTION identity_group_manual_change();
CREATE TABLE identity_emergencies (
 id text PRIMARY KEY, workspace_id text NOT NULL REFERENCES workspaces(id),
 requester_id text NOT NULL REFERENCES access_principals(id),
 approver_id text REFERENCES access_principals(id), reason text NOT NULL CHECK(length(trim(reason)) BETWEEN 10 AND 2000),
 page_ids text[] NOT NULL CHECK(cardinality(page_ids) BETWEEN 1 AND 100),
 actions text[] NOT NULL CHECK(cardinality(actions)>0 AND actions <@ ARRAY['knowledge.read','queue.triage','triage.manage']::text[]),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(), expires_at timestamptz NOT NULL,
 status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected','revoked')),
 revision integer NOT NULL DEFAULT 1,
 CHECK(approver_id IS NULL OR approver_id<>requester_id),
 CHECK(expires_at>created_at AND expires_at<=created_at+interval '30 minutes')
);
