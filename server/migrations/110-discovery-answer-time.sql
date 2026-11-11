-- Bound discovery scans by workspace and stored answer timestamp. No new user-event data is retained.
CREATE INDEX runtime_answers_discovery_time ON runtime_answers (workspace_id, (data->>'at'));
