-- Older receipts prove a mutation succeeded but do not attest its operation or time.
ALTER TABLE personal_saved_view_mutations
 ADD COLUMN operation text,
 ADD COLUMN applied_at timestamptz,
 ADD CONSTRAINT personal_saved_view_audit_pair CHECK (
   (operation IS NULL AND applied_at IS NULL) OR
   (operation IS NOT NULL AND operation IN ('create','edit','move','delete') AND applied_at IS NOT NULL)
 );
