-- Additive access model. Missing space metadata means quarantined, not inferred ownership.
CREATE TABLE access_principals (
 id text PRIMARY KEY, kind text NOT NULL DEFAULT 'human' CHECK(kind IN ('human','service')),
 issuer text, subject text, active boolean NOT NULL DEFAULT true,
 team_create boolean NOT NULL DEFAULT false, company_reader boolean NOT NULL DEFAULT false,
 UNIQUE(issuer,subject), CHECK((issuer IS NULL)=(subject IS NULL))
);
CREATE TABLE access_namespaces (
 id text PRIMARY KEY, kind text NOT NULL CHECK(kind IN ('personal','team')),
 slug text NOT NULL UNIQUE, name text NOT NULL, owner_id text REFERENCES access_principals(id),
 version integer NOT NULL DEFAULT 1,
 CHECK((kind='personal')=(owner_id IS NOT NULL))
);
CREATE TABLE access_team_members (
 team_id text REFERENCES access_namespaces(id), principal_id text REFERENCES access_principals(id),
 role text NOT NULL CHECK(role IN ('owner','member')), active boolean NOT NULL DEFAULT true,
 PRIMARY KEY(team_id,principal_id)
);
CREATE TABLE access_spaces (
 workspace_id text PRIMARY KEY REFERENCES workspaces(id), namespace_id text NOT NULL REFERENCES access_namespaces(id),
 slug text NOT NULL, visibility text NOT NULL DEFAULT 'private' CHECK(visibility IN ('private','team','company')),
 policy_version integer NOT NULL DEFAULT 1, active boolean NOT NULL DEFAULT true,
 minimum_approvals integer NOT NULL DEFAULT 1 CHECK(minimum_approvals>=1 AND minimum_approvals<=10),
 UNIQUE(namespace_id,slug)
);
CREATE TABLE access_groups (
 id text PRIMARY KEY, team_id text NOT NULL REFERENCES access_namespaces(id), name text NOT NULL,
 UNIQUE(team_id,name)
);
CREATE TABLE access_group_members (
 group_id text REFERENCES access_groups(id), principal_id text REFERENCES access_principals(id),
 PRIMARY KEY(group_id,principal_id)
);
CREATE TABLE access_grants (
 id text PRIMARY KEY, workspace_id text NOT NULL REFERENCES access_spaces(workspace_id),
 principal_id text REFERENCES access_principals(id), group_id text REFERENCES access_groups(id),
 role text NOT NULL CHECK(role IN ('read','triage','write','maintain','admin')),
 expires_at timestamptz, revoked boolean NOT NULL DEFAULT false,
 CHECK((principal_id IS NULL)<>(group_id IS NULL))
);
CREATE UNIQUE INDEX access_grant_principal ON access_grants(workspace_id,principal_id) WHERE principal_id IS NOT NULL;
CREATE UNIQUE INDEX access_grant_group ON access_grants(workspace_id,group_id) WHERE group_id IS NOT NULL;
CREATE TABLE access_reviewers (
 workspace_id text REFERENCES access_spaces(workspace_id), principal_id text REFERENCES access_principals(id),
 PRIMARY KEY(workspace_id,principal_id)
);
CREATE TABLE access_invitations (
 id text PRIMARY KEY, team_id text NOT NULL REFERENCES access_namespaces(id), principal_id text NOT NULL REFERENCES access_principals(id),
 kind text NOT NULL CHECK(kind IN ('member','owner-transfer')), from_id text NOT NULL REFERENCES access_principals(id),
 expires_at timestamptz NOT NULL, status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','accepted','revoked'))
);
CREATE TABLE access_credentials (
 id text PRIMARY KEY, hash text NOT NULL UNIQUE, principal_id text NOT NULL REFERENCES access_principals(id),
 workspace_id text NOT NULL REFERENCES access_spaces(workspace_id), actions text[] NOT NULL,
 expires_at timestamptz NOT NULL, revoked boolean NOT NULL DEFAULT false,
 created_at timestamptz NOT NULL DEFAULT now(), last_used_at timestamptz
);
CREATE TABLE access_shares (
 id text PRIMARY KEY, workspace_id text NOT NULL REFERENCES access_spaces(workspace_id),
 page_id text NOT NULL, version integer NOT NULL CHECK(version>0),
 principal_id text REFERENCES access_principals(id), group_id text REFERENCES access_groups(id),
 actions text[] NOT NULL, expires_at timestamptz NOT NULL, revoked boolean NOT NULL DEFAULT false,
 FOREIGN KEY(workspace_id,page_id,version) REFERENCES versions(workspace_id,page_id,number),
 CHECK((principal_id IS NULL)<>(group_id IS NULL))
);
CREATE TABLE access_batch_authors (
 workspace_id text, batch_id text, principal_id text NOT NULL REFERENCES access_principals(id),
 PRIMARY KEY(workspace_id,batch_id), FOREIGN KEY(workspace_id,batch_id) REFERENCES batches(workspace_id,id) ON DELETE CASCADE
);
ALTER TABLE approvals ADD COLUMN policy_version integer;
ALTER TABLE approvals DROP CONSTRAINT approvals_pkey;
ALTER TABLE approvals ADD PRIMARY KEY(workspace_id,batch_id,principal_id);
-- Old approvals do not prove independent designated review under the new policy.
DELETE FROM approvals;
DELETE FROM runtime_sessions;
