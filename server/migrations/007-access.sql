-- Existing workspaces stay on their verified legacy binding until an explicit,
-- operator-authorized adoption. A reviewer is never implicitly an administrator.
CREATE TABLE access_principals (
 id text PRIMARY KEY, display_name text NOT NULL, enabled boolean NOT NULL DEFAULT true
);
CREATE TABLE access_orgs (id text PRIMARY KEY, name text NOT NULL);
CREATE TABLE access_org_members (
 org_id text REFERENCES access_orgs(id), principal_id text REFERENCES access_principals(id),
 role text NOT NULL CHECK(role IN ('owner','member')), PRIMARY KEY(org_id,principal_id)
);
CREATE TABLE access_teams (
 id text PRIMARY KEY, org_id text NOT NULL REFERENCES access_orgs(id), name text NOT NULL,
 UNIQUE(org_id,name), UNIQUE(org_id,id)
);
CREATE TABLE access_team_members (
 org_id text, team_id text, principal_id text,
 PRIMARY KEY(team_id,principal_id),
 FOREIGN KEY(org_id,team_id) REFERENCES access_teams(org_id,id) ON DELETE CASCADE,
 FOREIGN KEY(org_id,principal_id) REFERENCES access_org_members(org_id,principal_id) ON DELETE CASCADE
);
CREATE TABLE access_spaces (
 workspace_id text PRIMARY KEY REFERENCES workspaces(id), name text NOT NULL,
 owner_id text REFERENCES access_principals(id), org_id text REFERENCES access_orgs(id),
 visibility text NOT NULL DEFAULT 'private' CHECK(visibility IN ('private','team')),
 revision integer NOT NULL DEFAULT 1,
 CHECK((owner_id IS NOT NULL)::integer+(org_id IS NOT NULL)::integer=1),
 CHECK(owner_id IS NULL OR visibility='private')
);
CREATE TABLE access_grants (
 id text PRIMARY KEY, workspace_id text NOT NULL REFERENCES access_spaces(workspace_id),
 principal_id text REFERENCES access_principals(id), team_id text REFERENCES access_teams(id) ON DELETE CASCADE,
 role text NOT NULL CHECK(role IN ('Read','Triage','Write','Maintain','Admin')),
 expires_at timestamptz, granted_by text NOT NULL, CHECK((principal_id IS NOT NULL)::integer+(team_id IS NOT NULL)::integer=1)
);
CREATE UNIQUE INDEX access_direct_grant ON access_grants(workspace_id,principal_id) WHERE principal_id IS NOT NULL;
CREATE UNIQUE INDEX access_team_grant ON access_grants(workspace_id,team_id) WHERE team_id IS NOT NULL;
CREATE TABLE access_invitations (
 id text PRIMARY KEY, org_id text NOT NULL REFERENCES access_orgs(id),
 workspace_id text REFERENCES access_spaces(workspace_id), principal_id text NOT NULL REFERENCES access_principals(id),
 role text NOT NULL CHECK(role IN ('owner','member','Read','Triage','Write','Maintain','Admin')),
 invited_by text NOT NULL, expires_at timestamptz NOT NULL,
 status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','accepted','cancelled')),
 CHECK((workspace_id IS NULL AND role IN ('owner','member')) OR (workspace_id IS NOT NULL AND role NOT IN ('owner','member')))
);
CREATE TABLE access_reviewers (
 workspace_id text REFERENCES access_spaces(workspace_id),principal_id text REFERENCES access_principals(id),
 PRIMARY KEY(workspace_id,principal_id)
);
CREATE TABLE access_audit (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, actor_id text NOT NULL,
 operation text NOT NULL, resource_id text NOT NULL, details jsonb NOT NULL DEFAULT '{}',
 at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE access_triage (
 workspace_id text NOT NULL, batch_id text NOT NULL, principal_id text NOT NULL,
 label text NOT NULL CHECK(label IN ('untriaged','needs-review','duplicate','blocked')),
 PRIMARY KEY(workspace_id,batch_id), FOREIGN KEY(workspace_id,batch_id) REFERENCES batches(workspace_id,id)
);

-- Return an action role only. Resource/source allowlists remain a separate ceiling.
CREATE FUNCTION access_role(space text, who text) RETURNS text LANGUAGE sql STABLE AS $$
 WITH s AS (SELECT * FROM access_spaces WHERE workspace_id=space),
 eligible AS (SELECT 1 FROM access_principals WHERE id=who AND enabled),
 roles AS (
  SELECT 5 AS level FROM s,eligible WHERE s.owner_id=who OR EXISTS
   (SELECT 1 FROM access_org_members m WHERE m.org_id=s.org_id AND m.principal_id=who AND m.role='owner')
  UNION ALL SELECT CASE g.role WHEN 'Read' THEN 1 WHEN 'Triage' THEN 2 WHEN 'Write' THEN 3 WHEN 'Maintain' THEN 4 WHEN 'Admin' THEN 5 END
   FROM s,eligible,access_grants g WHERE g.workspace_id=s.workspace_id AND (g.expires_at IS NULL OR g.expires_at>clock_timestamp())
   AND EXISTS(SELECT 1 FROM access_org_members m WHERE m.org_id=s.org_id AND m.principal_id=who)
   AND (g.principal_id=who OR EXISTS(SELECT 1 FROM access_team_members tm WHERE tm.org_id=s.org_id AND tm.team_id=g.team_id AND tm.principal_id=who))
  UNION ALL SELECT 1 FROM s,eligible WHERE s.visibility='team' AND EXISTS
   (SELECT 1 FROM access_org_members m WHERE m.org_id=s.org_id AND m.principal_id=who)
 ) SELECT CASE max(level) WHEN 1 THEN 'Read' WHEN 2 THEN 'Triage' WHEN 3 THEN 'Write' WHEN 4 THEN 'Maintain' WHEN 5 THEN 'Admin' END FROM roles
$$;
CREATE FUNCTION effective_membership(space text, who text) RETURNS text LANGUAGE sql STABLE AS $$
 SELECT CASE WHEN EXISTS(SELECT 1 FROM access_spaces WHERE workspace_id=space) THEN
  CASE access_role(space,who) WHEN 'Read' THEN 'reader' WHEN 'Triage' THEN 'reader' WHEN 'Write' THEN 'editor' WHEN 'Maintain' THEN 'reviewer' WHEN 'Admin' THEN 'reviewer' END
 ELSE (SELECT role FROM memberships WHERE workspace_id=space AND principal_id=who) END
$$;
