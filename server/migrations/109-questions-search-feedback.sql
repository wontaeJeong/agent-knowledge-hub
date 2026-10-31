-- Private conversations. No workspace/administrator role grants access to these rows.
CREATE TABLE question_threads (
 workspace_id text NOT NULL REFERENCES workspaces(id), id text NOT NULL,
 principal_id text NOT NULL, revision integer NOT NULL DEFAULT 0,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(workspace_id,id)
);
CREATE INDEX question_threads_owner ON question_threads(workspace_id,principal_id,created_at,id);
CREATE TABLE question_turns (
 workspace_id text NOT NULL, thread_id text NOT NULL, id text NOT NULL,
 principal_id text NOT NULL, ordinal integer NOT NULL, nonce text NOT NULL,
 request_hash text NOT NULL, question text NOT NULL, mode text NOT NULL CHECK(mode IN ('offline','model')),
 status text NOT NULL CHECK(status IN ('pending','completed')),
 sealed jsonb NOT NULL, job_id text, answer_id text, answer_version integer,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(workspace_id,id),
 FOREIGN KEY(workspace_id,thread_id) REFERENCES question_threads(workspace_id,id),
 UNIQUE(workspace_id,thread_id,ordinal), UNIQUE(workspace_id,thread_id,nonce),
 CHECK((status='pending' AND answer_id IS NULL AND answer_version IS NULL) OR
       (status='completed' AND answer_id IS NOT NULL AND answer_version=1))
);
CREATE TABLE question_feedback (
 workspace_id text NOT NULL REFERENCES workspaces(id), id text NOT NULL,
 principal_id text NOT NULL, nonce text NOT NULL, request_hash text NOT NULL,
 answer_id text NOT NULL, answer_version integer NOT NULL CHECK(answer_version=1),
 category text NOT NULL CHECK(category IN ('incorrect','citationmissing','exposure')),
 reason text NOT NULL, evidence jsonb NOT NULL, input_envelope jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(workspace_id,id), UNIQUE(workspace_id,principal_id,nonce)
);
CREATE TABLE question_feedback_work (
 workspace_id text NOT NULL, feedback_id text NOT NULL, page_id text NOT NULL,
 page_version integer NOT NULL, owner_revision integer, recipient_ids text[] NOT NULL,
 status text NOT NULL CHECK(status IN ('pending','pending-unassigned')),
 evidence_keys jsonb NOT NULL,
 PRIMARY KEY(workspace_id,feedback_id,page_id,page_version),
 FOREIGN KEY(workspace_id,feedback_id) REFERENCES question_feedback(workspace_id,id)
);
