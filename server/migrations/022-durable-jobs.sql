-- Additive queue: runtime_jobs remains the legacy HTTP execution history.
CREATE TABLE durable_jobs (
 id text PRIMARY KEY,
 workspace_id text NOT NULL REFERENCES workspaces(id), principal_id text NOT NULL,
 credential_id text NOT NULL, kind text NOT NULL, lane text NOT NULL CHECK(lane IN ('interactive','maintenance')),
 idempotency_key text NOT NULL, body_hash text NOT NULL, input jsonb NOT NULL,
 envelope jsonb NOT NULL, policy_hash text NOT NULL,
 status text NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','running','cancel_requested','cancelled','succeeded','dead','paused')),
 worker_id text, fence integer NOT NULL DEFAULT 0, attempts integer NOT NULL DEFAULT 0,
 max_attempts integer NOT NULL CHECK(max_attempts BETWEEN 1 AND 10), timeout_ms integer NOT NULL CHECK(timeout_ms BETWEEN 10 AND 3600000),
 available_at timestamptz NOT NULL, lease_until timestamptz, heartbeat_at timestamptz, started_at timestamptz,
 created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL,
 checkpoint jsonb, result jsonb, error_code text,
 budget_day date NOT NULL, reserved_tokens bigint NOT NULL CHECK(reserved_tokens>=0), reserved_cost_micros bigint NOT NULL CHECK(reserved_cost_micros>=0),
 reconciled boolean NOT NULL DEFAULT false,
 UNIQUE(workspace_id,principal_id,idempotency_key)
);
CREATE INDEX durable_jobs_claim ON durable_jobs(lane,status,available_at,created_at);
CREATE INDEX durable_jobs_owner ON durable_jobs(workspace_id,principal_id,status);
CREATE TABLE durable_job_fairness (
 scope text PRIMARY KEY, turn bigint NOT NULL
);
CREATE SEQUENCE durable_job_turn;
CREATE TABLE durable_budget_limits (
 workspace_id text NOT NULL REFERENCES workspaces(id), principal_id text NOT NULL,
 tokens bigint NOT NULL CHECK(tokens>=0), cost_micros bigint NOT NULL CHECK(cost_micros>=0),
 PRIMARY KEY(workspace_id,principal_id)
);
CREATE TABLE durable_budget_days (
 workspace_id text NOT NULL REFERENCES workspaces(id), principal_id text NOT NULL, day date NOT NULL,
 tokens_reserved bigint NOT NULL DEFAULT 0, cost_reserved bigint NOT NULL DEFAULT 0,
 tokens_charged bigint NOT NULL DEFAULT 0, cost_charged bigint NOT NULL DEFAULT 0,
 PRIMARY KEY(workspace_id,principal_id,day),
 CHECK(tokens_reserved>=0 AND cost_reserved>=0 AND tokens_charged>=0 AND cost_charged>=0)
);
CREATE TABLE durable_model_calls (
 job_id text NOT NULL REFERENCES durable_jobs(id), call_id text NOT NULL, attempt integer NOT NULL,
 provider text NOT NULL, model text NOT NULL,
 input_tokens bigint, output_tokens bigint, cost_micros bigint, error_code text,
 body_hash text NOT NULL, created_at timestamptz NOT NULL,
 PRIMARY KEY(job_id,call_id),
 CHECK(input_tokens IS NULL OR input_tokens>=0), CHECK(output_tokens IS NULL OR output_tokens>=0), CHECK(cost_micros IS NULL OR cost_micros>=0)
);
CREATE TABLE durable_job_outbox (
 id text PRIMARY KEY, job_id text NOT NULL REFERENCES durable_jobs(id), topic text NOT NULL, payload jsonb NOT NULL,
 created_at timestamptz NOT NULL, delivered_at timestamptz, worker_id text, fence integer NOT NULL DEFAULT 0,
 lease_until timestamptz, UNIQUE(job_id,topic)
);
CREATE INDEX durable_job_outbox_pending ON durable_job_outbox(created_at) WHERE delivered_at IS NULL;
CREATE TABLE durable_job_stops (
 scope text NOT NULL CHECK(scope IN ('global','workspace','kind','model','rule')), key text NOT NULL,
 stopped boolean NOT NULL, changed_by text NOT NULL, changed_at timestamptz NOT NULL,
 PRIMARY KEY(scope,key)
);
CREATE TABLE durable_schedules (
 id text PRIMARY KEY, workspace_id text NOT NULL REFERENCES workspaces(id), schedule_key text NOT NULL,
 revision integer NOT NULL, approved_by text NOT NULL, identity jsonb NOT NULL, config jsonb NOT NULL,
 enabled boolean NOT NULL DEFAULT true, next_at timestamptz NOT NULL, last_at timestamptz,
 last_error text, updated_at timestamptz NOT NULL,
 UNIQUE(workspace_id,schedule_key)
);
CREATE TABLE durable_schedule_runs (
 schedule_id text NOT NULL REFERENCES durable_schedules(id), local_date text NOT NULL,
 scheduled_at timestamptz NOT NULL, job_id text NOT NULL REFERENCES durable_jobs(id),
 PRIMARY KEY(schedule_id,local_date)
);
CREATE TABLE durable_schedule_versions (
 schedule_id text NOT NULL REFERENCES durable_schedules(id), revision integer NOT NULL,
 approved_by text NOT NULL, config jsonb NOT NULL, identity jsonb NOT NULL, created_at timestamptz NOT NULL,
 PRIMARY KEY(schedule_id,revision)
);
