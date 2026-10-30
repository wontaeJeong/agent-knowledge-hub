CREATE TABLE access_service_accounts (
 principal_id text PRIMARY KEY REFERENCES access_principals(id),
 namespace_id text NOT NULL REFERENCES access_namespaces(id), name text NOT NULL,
 sponsor_id text NOT NULL REFERENCES access_principals(id), expires_at timestamptz NOT NULL
);
