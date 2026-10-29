-- Existing approvals without a permission snapshot must be recreated/reviewed.
ALTER TABLE approvals ADD COLUMN acl_hash text;
