-- Per-actual-attempt receipts survive original upload/run removal; no prompts, chunks or access tokens.
CREATE TABLE import_model_calls (
 workspace_id text NOT NULL REFERENCES workspaces(id), call_id text NOT NULL, run_id text NOT NULL, import_id text NOT NULL,
 principal_id text NOT NULL, attempt integer NOT NULL, lease_token bigint NOT NULL, call_index integer NOT NULL,
 phase text NOT NULL CHECK(phase IN ('extract','consolidate')), input_revision integer NOT NULL,
 input_hash text NOT NULL, private_input_hash text NOT NULL, context_bytes integer NOT NULL,
 requested_provider text, requested_model text, actual_provider text, actual_model text,
 input_tokens bigint CHECK(input_tokens IS NULL OR input_tokens>=0), output_tokens bigint CHECK(output_tokens IS NULL OR output_tokens>=0),
 cost_micros bigint CHECK(cost_micros IS NULL OR cost_micros>=0), provider_error_code text, effect_error_code text,
 state text NOT NULL DEFAULT 'in_flight' CHECK(state IN ('in_flight','reported','usage_unknown')),
 budget_day date NOT NULL, reserved_tokens bigint NOT NULL CHECK(reserved_tokens>=0), reserved_cost_micros bigint NOT NULL CHECK(reserved_cost_micros>=0),
 tokens_settled boolean NOT NULL DEFAULT false, cost_settled boolean NOT NULL DEFAULT false, usage_hash text,
 request_id text, job_id text, created_at timestamptz NOT NULL DEFAULT now(), started_at timestamptz, finished_at timestamptz,
 PRIMARY KEY(workspace_id,call_id), UNIQUE(workspace_id,run_id,attempt,call_index)
);
CREATE INDEX import_model_calls_run ON import_model_calls(workspace_id,run_id,created_at);
