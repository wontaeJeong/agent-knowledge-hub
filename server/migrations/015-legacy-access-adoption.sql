-- One canonical authority, preserving released007 product ownership and IDs.
-- issuer/subject are NEVER inferred from names. Active OIDC login may attach the
-- verified issuer+subject only when its canonical SHA256 ID matches this stable ID.
ALTER TABLE access_principals ADD COLUMN display_name text;
ALTER TABLE access_spaces ADD COLUMN name text;
DO $adopt$
BEGIN
 IF to_regclass('legacy_v1_access_principals') IS NOT NULL THEN
  INSERT INTO access_principals(id,active,display_name)
   SELECT id,enabled,display_name FROM legacy_v1_access_principals;
  -- Retain historical actors/references lacking a verified principal, but disabled.
  INSERT INTO access_principals(id,active,display_name)
   SELECT DISTINCT id,false,id FROM (
    SELECT actor_id AS id FROM legacy_v1_access_audit
    UNION SELECT invited_by FROM legacy_v1_access_invitations
    UNION SELECT principal_id FROM legacy_v1_access_org_members
    UNION SELECT owner_id FROM legacy_v1_access_spaces WHERE owner_id IS NOT NULL
   ) unknown WHERE id IS NOT NULL ON CONFLICT DO NOTHING;
  INSERT INTO access_namespaces(id,kind,slug,name)
   SELECT id,'team','org-'||md5(id),name FROM legacy_v1_access_orgs;
  INSERT INTO access_team_members(team_id,principal_id,role)
   SELECT org_id,principal_id,role FROM legacy_v1_access_org_members;
  INSERT INTO access_namespaces(id,kind,slug,name,owner_id)
   SELECT 'legacy-personal-'||md5(owner_id),'personal','user-'||md5(owner_id),'개인',owner_id
   FROM legacy_v1_access_spaces WHERE owner_id IS NOT NULL GROUP BY owner_id;
  INSERT INTO access_spaces(workspace_id,namespace_id,slug,visibility,policy_version,name)
   SELECT s.workspace_id,coalesce(s.org_id,'legacy-personal-'||md5(s.owner_id)),
    'space-'||md5(s.workspace_id),s.visibility,greatest(s.revision,1),s.name
   FROM legacy_v1_access_spaces s WHERE s.owner_id IS NOT NULL OR EXISTS
    (SELECT 1 FROM legacy_v1_access_org_members m WHERE m.org_id=s.org_id AND m.role='owner');
  -- No owned namespace mapping is synthesized from legacy memberships/reviewer.
  -- Old org spaces without ANY explicitly recorded owner remain unadopted/quarantined.
  INSERT INTO access_groups(id,team_id,name) SELECT id,org_id,name FROM legacy_v1_access_teams;
  INSERT INTO access_group_members(group_id,principal_id) SELECT team_id,principal_id FROM legacy_v1_access_team_members;
  INSERT INTO access_grants(id,workspace_id,principal_id,group_id,role,expires_at)
   SELECT g.id,g.workspace_id,g.principal_id,g.team_id,lower(g.role),g.expires_at
   FROM legacy_v1_access_grants g JOIN access_spaces s ON s.workspace_id=g.workspace_id;
  INSERT INTO access_reviewers SELECT r.workspace_id,r.principal_id FROM legacy_v1_access_reviewers r JOIN access_spaces s ON s.workspace_id=r.workspace_id;
  -- Compatibility FK rows never confer rights: both SQL helpers below and the
  -- application engine require canonical ownership/membership/current grants.
  INSERT INTO memberships(workspace_id,principal_id,role)
   SELECT s.workspace_id,m.principal_id,'reader' FROM access_spaces s
   JOIN access_team_members m ON m.team_id=s.namespace_id AND m.active
   JOIN access_principals p ON p.id=m.principal_id AND p.active ON CONFLICT DO NOTHING;
  INSERT INTO memberships(workspace_id,principal_id,role)
   SELECT s.workspace_id,n.owner_id,'reader' FROM access_spaces s
   JOIN access_namespaces n ON n.id=s.namespace_id AND n.kind='personal'
   JOIN access_principals p ON p.id=n.owner_id AND p.active ON CONFLICT DO NOTHING;
  -- Released publication code records these server-owned author fields. Preserve
  -- actual import author rather than the disclosure reviewer who staged it.
  -- Missing author metadata remains blocked; never infer author from Owner/role/name.
  INSERT INTO access_batch_authors(workspace_id,batch_id,principal_id)
   SELECT b.workspace_id,b.id,p.id FROM batches b
   JOIN access_spaces s ON s.workspace_id=b.workspace_id
   JOIN access_principals p ON p.id=coalesce(b.data->>'importAuthorId',b.data->>'proposedBy')
   WHERE p.kind='human';
  INSERT INTO access_invitations(id,team_id,principal_id,kind,from_id,expires_at,status)
   SELECT i.id,i.org_id,i.principal_id,CASE WHEN i.role='owner' THEN 'owner-transfer' ELSE 'member' END,
    i.invited_by,i.expires_at,CASE WHEN i.status='cancelled' THEN 'revoked' ELSE i.status END
   FROM legacy_v1_access_invitations i;
  INSERT INTO access_audit(principal_id,operation,workspace_id,target_id,data,at)
   SELECT i.invited_by,'legacy.invitation',CASE WHEN EXISTS(SELECT 1 FROM workspaces w WHERE w.id=i.workspace_id) THEN i.workspace_id END,
    i.id,jsonb_build_object('role',i.role,'workspaceId',i.workspace_id,'retainPreviousOwner',i.role='owner'),clock_timestamp()
   FROM legacy_v1_access_invitations i;
  INSERT INTO access_audit(principal_id,operation,workspace_id,target_id,data,at)
   SELECT a.actor_id,a.operation,CASE WHEN EXISTS(SELECT 1 FROM workspaces w WHERE w.id=a.resource_id) THEN a.resource_id END,
    a.resource_id,a.details||jsonb_build_object('legacyAuditId',a.id),a.at FROM legacy_v1_access_audit a;
 END IF;
END $adopt$;
-- All pre-transition approvals are invalid, but immutable proposal body/hash/input
-- provenance are retained for fresh designated-human review where author is known.
UPDATE batches SET data=jsonb_set(data,'{status}','"pending"') WHERE data->>'status'='approved';

-- Released RuntimeService.triage continues using the same relation/IDs.
CREATE TABLE IF NOT EXISTS access_triage (
 workspace_id text NOT NULL,batch_id text NOT NULL,principal_id text NOT NULL,
 label text NOT NULL CHECK(label IN ('untriaged','needs-review','duplicate','blocked')),
 PRIMARY KEY(workspace_id,batch_id),FOREIGN KEY(workspace_id,batch_id) REFERENCES batches(workspace_id,id)
);
DO $triage$ BEGIN
 IF to_regclass('legacy_v1_access_triage') IS NOT NULL THEN
  INSERT INTO access_triage SELECT * FROM legacy_v1_access_triage ON CONFLICT DO NOTHING;
 END IF;
END $triage$;

-- These compatibility helpers return ACTION roles only. They do NOT authorize
-- source/page ancestry, credential scopes, human review, export or publication.
-- Every ImportService route/job still needs authorizeInTransaction(ctx,action,...).
CREATE OR REPLACE FUNCTION access_role(space text,who text) RETURNS text LANGUAGE sql STABLE AS $$
 WITH s AS (
  SELECT s.*,n.kind,n.owner_id,p.kind AS principal_kind,p.company_reader
  FROM access_spaces s JOIN access_namespaces n ON n.id=s.namespace_id
  JOIN access_principals p ON p.id=who AND p.active
  WHERE s.workspace_id=space AND s.active AND
   (p.kind='human' OR EXISTS(SELECT 1 FROM access_service_accounts sa
    JOIN access_principals sponsor ON sponsor.id=sa.sponsor_id AND sponsor.active AND sponsor.kind='human'
    JOIN access_team_members sm ON sm.team_id=sa.namespace_id AND sm.principal_id=sponsor.id AND sm.active
    WHERE sa.principal_id=p.id AND sa.namespace_id=s.namespace_id AND sa.expires_at>clock_timestamp()))
 ), membership AS (SELECT m.* FROM access_team_members m,s WHERE m.team_id=s.namespace_id AND m.principal_id=who AND m.active),
 roles AS (
  SELECT 5 AS level FROM s WHERE (s.kind='personal' AND s.owner_id=who) OR
   (s.kind='team' AND EXISTS(SELECT 1 FROM membership WHERE role='owner'))
  UNION ALL SELECT CASE g.role WHEN 'read' THEN 1 WHEN 'triage' THEN 2 WHEN 'write' THEN 3 WHEN 'maintain' THEN 4 WHEN 'admin' THEN 5 END
   FROM access_grants g,s WHERE s.kind='team' AND g.workspace_id=s.workspace_id AND NOT g.revoked
    AND (g.expires_at IS NULL OR g.expires_at>clock_timestamp()) AND EXISTS(SELECT 1 FROM membership)
    AND (g.principal_id=who OR EXISTS(SELECT 1 FROM access_group_members gm JOIN access_groups ag ON ag.id=gm.group_id WHERE gm.principal_id=who AND gm.group_id=g.group_id AND ag.team_id=s.namespace_id))
  UNION ALL SELECT 1 FROM s WHERE s.principal_kind='human' AND ((s.visibility='team' AND EXISTS(SELECT 1 FROM membership)) OR(s.visibility='company' AND s.company_reader))
 ), effective AS (SELECT CASE WHEN (SELECT principal_kind FROM s)='service' THEN least(max(level),3) ELSE max(level) END AS level FROM roles)
 SELECT CASE level WHEN 1 THEN 'Read' WHEN 2 THEN 'Triage' WHEN 3 THEN 'Write' WHEN 4 THEN 'Maintain' WHEN 5 THEN 'Admin' END FROM effective
 WHERE EXISTS(SELECT 1 FROM s WHERE kind='team' OR owner_id=who)
$$;
CREATE OR REPLACE FUNCTION effective_membership(space text,who text) RETURNS text LANGUAGE sql STABLE AS $$
 SELECT CASE access_role(space,who) WHEN 'Read' THEN 'reader' WHEN 'Triage' THEN 'reader' WHEN 'Write' THEN 'editor' WHEN 'Maintain' THEN 'reviewer' WHEN 'Admin' THEN 'reviewer' END
$$;
