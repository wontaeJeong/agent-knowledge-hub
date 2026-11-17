-- Content identity is separate from CAS hashes: runtime records authorize no file purge.
-- Legacy ID-only runtime retirements remain fences but cannot delete restored content.
ALTER TABLE operations_erased_artifacts ADD COLUMN identity_hash text
 CHECK(identity_hash IS NULL OR identity_hash ~ '^[a-f0-9]{64}$');
