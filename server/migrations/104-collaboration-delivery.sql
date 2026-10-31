-- User collaboration delivery; distinct from operations alerts and web read_at.
CREATE TABLE collaboration_digest_plans (
 id text PRIMARY KEY, workspace_id text NOT NULL REFERENCES workspaces(id), principal_id text NOT NULL,
 cadence text NOT NULL CHECK(cadence IN ('daily','weekly')), preference_revision integer NOT NULL,
 preference_hash text NOT NULL, preferences jsonb NOT NULL,
 cursor_at timestamptz NOT NULL, next_at timestamptz NOT NULL,
 status text NOT NULL CHECK(status IN ('active','superseded','blocked')),
 created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL,
 UNIQUE(workspace_id,principal_id,cadence,preference_hash)
);
CREATE INDEX collaboration_plans_due ON collaboration_digest_plans(status,next_at);
CREATE TABLE collaboration_digest_outbox (
 id text PRIMARY KEY, plan_id text NOT NULL REFERENCES collaboration_digest_plans(id),
 workspace_id text NOT NULL REFERENCES workspaces(id), principal_id text NOT NULL, cadence text NOT NULL,
 preference_hash text NOT NULL, event_ids text[] NOT NULL,
 window_start timestamptz NOT NULL, window_end timestamptz NOT NULL, available_at timestamptz NOT NULL,
 status text NOT NULL CHECK(status IN ('queued','running','retry','accepted','delivered','no-delivery','failed','superseded','unconfigured','needs-reconciliation')),
 worker_id text, fence integer NOT NULL DEFAULT 0, attempts integer NOT NULL DEFAULT 0,
 max_attempts integer NOT NULL CHECK(max_attempts BETWEEN 1 AND 10), lease_until timestamptz,
 payload_hash text, recipient_binding_hash text, input_hash text,
 dispatch_started_at timestamptz, receipt_id text, delivered_at timestamptz, error_code text,
 created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL,
 UNIQUE(plan_id,window_end)
);
CREATE INDEX collaboration_outbox_claim ON collaboration_digest_outbox(status,available_at);
CREATE TABLE collaboration_delivery_receipts (
 delivery_id text PRIMARY KEY REFERENCES collaboration_digest_outbox(id), receipt_id text NOT NULL,
 status text NOT NULL CHECK(status IN ('accepted','delivered')), payload_hash text NOT NULL,
 recorded_at timestamptz NOT NULL
);
CREATE TABLE collaboration_delivery_events (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, delivery_id text NOT NULL REFERENCES collaboration_digest_outbox(id),
 kind text NOT NULL, code text, at timestamptz NOT NULL
);
CREATE TABLE collaboration_review_cadence (
 workspace_id text NOT NULL REFERENCES workspaces(id), document_type text NOT NULL,
 revision integer NOT NULL CHECK(revision>0), days integer NOT NULL CHECK(days BETWEEN 1 AND 3650),
 updated_by text NOT NULL, updated_at timestamptz NOT NULL,
 PRIMARY KEY(workspace_id,document_type)
);
CREATE TABLE collaboration_review_due_work (
 id text PRIMARY KEY, workspace_id text NOT NULL REFERENCES workspaces(id), page_id text NOT NULL,
 page_version integer NOT NULL, due_cycle text NOT NULL, document_type text NOT NULL, due_at timestamptz,
 input_hash text NOT NULL, policy_hash text NOT NULL, assignment_revision text NOT NULL,
 owner_id text, backup_id text, assigned_id text,
 revision integer NOT NULL DEFAULT 1,
 status text NOT NULL CHECK(status IN ('needs-review','needs-assignment','acknowledged','resolved','superseded')),
 reason_code text NOT NULL, acknowledged_at timestamptz, created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL,
 UNIQUE(workspace_id,page_id,due_cycle)
);
CREATE INDEX collaboration_review_inbox ON collaboration_review_due_work(workspace_id,assigned_id,status,due_at);
