-- Opt-in agent credentials, isolated by owner and workspace. Plaintext secrets are NEVER stored.
CREATE TABLE agent_device_clients (
 id uuid PRIMARY KEY,
 workspace_id text NOT NULL REFERENCES workspaces(id),
 principal_id text NOT NULL,
 name text NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
 active boolean NOT NULL DEFAULT true,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX agent_device_client_owner ON agent_device_clients(workspace_id,principal_id,created_at DESC);
CREATE TABLE agent_api_keys (
 id uuid PRIMARY KEY,
 workspace_id text NOT NULL REFERENCES workspaces(id),
 principal_id text NOT NULL,
 device_client_id uuid REFERENCES agent_device_clients(id),
 name text NOT NULL CHECK(length(name) BETWEEN 1 AND 100),
 token_hash text UNIQUE NOT NULL,
 suffix text NOT NULL,
 scope text NOT NULL CHECK(scope IN ('read','write')),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 expires_at timestamptz NOT NULL,
 revoked_at timestamptz,
 last_used_at timestamptz,
 CHECK(expires_at > created_at AND expires_at <= created_at + interval '90 days 1 minute')
);
CREATE INDEX agent_api_keys_owner ON agent_api_keys(workspace_id,principal_id,created_at DESC);
CREATE TABLE agent_key_requests (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 key_id uuid NOT NULL REFERENCES agent_api_keys(id) ON DELETE CASCADE,
 route text NOT NULL,
 at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX agent_key_requests_recent ON agent_key_requests(key_id,at DESC);
CREATE TABLE agent_device_grants (
 id uuid PRIMARY KEY,
 client_id uuid NOT NULL REFERENCES agent_device_clients(id),
 workspace_id text NOT NULL REFERENCES workspaces(id),
 device_hash text NOT NULL UNIQUE,
 user_code text NOT NULL UNIQUE CHECK(length(user_code)=8),
 requested_scope text NOT NULL CHECK(requested_scope IN ('read','write')),
 status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','denied','consumed')),
 approved_by text,
 expires_at timestamptz NOT NULL,
 last_poll_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX agent_device_grants_client ON agent_device_grants(client_id,created_at DESC);

-- Metrics record NO prompts, credentials, responses, source IDs or model endpoint URLs.
CREATE TABLE model_usage_events (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 workspace_id text NOT NULL REFERENCES workspaces(id),
 principal_id text NOT NULL,
 operation text NOT NULL CHECK(operation IN ('ingest','query','organize','assess')),
 provider text NOT NULL CHECK(provider IN ('openai','litellm','bedrock','systemone')),
 backend text NOT NULL CHECK(backend IN ('unknown','onprem','bedrock','systemone','external')),
 model text NOT NULL,
 deployment_id text,
 succeeded boolean NOT NULL,
 latency_ms double precision NOT NULL CHECK(latency_ms >= 0),
 input_tokens bigint CHECK(input_tokens >= 0),
 output_tokens bigint CHECK(output_tokens >= 0),
 cache_read_tokens bigint CHECK(cache_read_tokens >= 0),
 cache_write_tokens bigint CHECK(cache_write_tokens >= 0),
 cost_usd numeric(22,10) CHECK(cost_usd >= 0),
 error_code text,
 at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX model_usage_workspace ON model_usage_events(workspace_id,at DESC);
CREATE INDEX model_usage_principal ON model_usage_events(workspace_id,principal_id,at DESC);

CREATE TABLE agent_key_audit (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 workspace_id text NOT NULL REFERENCES workspaces(id),
 actor_id text NOT NULL,
 key_id uuid NOT NULL REFERENCES agent_api_keys(id),
 action text NOT NULL CHECK(action IN ('issue','revoke')),
 reason text CHECK(reason IS NULL OR length(reason) BETWEEN 5 AND 500),
 at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX agent_key_audit_workspace ON agent_key_audit(workspace_id,at DESC);
ALTER TABLE agent_device_grants ADD COLUMN consumed_at timestamptz;
