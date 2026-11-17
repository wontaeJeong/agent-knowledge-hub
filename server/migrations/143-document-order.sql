-- Separate from workflow_document_state: released positional INSERT contracts remain valid.
-- Page identity is unique; equal sibling ranks use stable page ID as a deterministic tiebreak.
CREATE TABLE workflow_document_order (
  workspace_id text NOT NULL,
  page_id text NOT NULL,
  position bigint NOT NULL CHECK(position >= 0),
  PRIMARY KEY(workspace_id,page_id),
  FOREIGN KEY(workspace_id,page_id) REFERENCES pages(workspace_id,id) ON DELETE CASCADE
);
CREATE INDEX workflow_document_order_scan ON workflow_document_order(workspace_id,position,page_id);
-- Bounded inserts; default ID order for pages created after migration remains valid until reordered.
DO $$
DECLARE affected integer;
BEGIN
  LOOP
    INSERT INTO workflow_document_order(workspace_id,page_id,position)
      SELECT p.workspace_id,p.id,0 FROM pages p
      WHERE NOT EXISTS(SELECT 1 FROM workflow_document_order o WHERE o.workspace_id=p.workspace_id AND o.page_id=p.id)
      ORDER BY p.workspace_id,p.id LIMIT 500;
    GET DIAGNOSTICS affected = ROW_COUNT;
    EXIT WHEN affected = 0;
  END LOOP;
END $$;
