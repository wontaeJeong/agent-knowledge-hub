-- Keep genuinely unattributed v146 receipts, but reject new unaudited writes,
-- including a v146 web process still serving during the migration window.
ALTER TABLE personal_saved_view_mutations
 ADD CONSTRAINT personal_saved_view_audit_required
 CHECK (operation IS NOT NULL AND applied_at IS NOT NULL) NOT VALID;
