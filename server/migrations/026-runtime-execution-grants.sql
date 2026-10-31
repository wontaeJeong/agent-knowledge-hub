-- A consented one-operation execution grant is not a stored OIDC session.
-- Its credential secret is generated then discarded; only a random hash lives
-- in the canonical access_credentials table, so all policy intersections apply.
CREATE TABLE runtime_execution_grants (
 credential_id text PRIMARY KEY REFERENCES access_credentials(id),
 workspace_id text NOT NULL REFERENCES workspaces(id), principal_id text NOT NULL REFERENCES access_principals(id),
 operation text NOT NULL CHECK(operation IN ('ingest','query','lint')),
 payload_hash text NOT NULL, page_ids text[] NOT NULL, source_ids text[] NOT NULL,
 parent_credential_id text REFERENCES access_credentials(id),
 parent_session_id text CHECK(parent_session_id IS NULL OR parent_session_id ~ '^[a-f0-9]{64}$'),
 parent_session_snapshot jsonb,
 request_key text NOT NULL, job_id text,
 timeout_ms integer NOT NULL CHECK(timeout_ms BETWEEN 10 AND 3600000),
 created_at timestamptz NOT NULL, expires_at timestamptz NOT NULL, revoked boolean NOT NULL DEFAULT false,
 CHECK(expires_at>created_at AND expires_at<=created_at+timeout_ms*interval '1 millisecond'),
 CHECK((parent_session_id IS NULL)=(parent_session_snapshot IS NULL)),
 CHECK(parent_credential_id IS NULL OR parent_session_id IS NULL),
 UNIQUE(workspace_id,principal_id,request_key)
);
-- Independent current-directory proof, not an old browser login/session.
CREATE TABLE runtime_directory_status (
 principal_id text PRIMARY KEY REFERENCES access_principals(id),
 provider_id text NOT NULL, identity_hash text NOT NULL, active boolean,
 verified_at timestamptz NOT NULL, valid_until timestamptz NOT NULL,
 CHECK(valid_until>=verified_at)
);
-- Keep requested routing aliases distinct from an actual provider response.
ALTER TABLE durable_model_calls ADD COLUMN requested_model text;
ALTER TABLE durable_model_calls ALTER COLUMN model DROP NOT NULL;
