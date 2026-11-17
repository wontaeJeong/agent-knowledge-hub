-- Disposable published-only index. Portable Markdown and canonical version references remain authoritative.
-- Run scripts/rebuild-links.ts in bounded resumable batches for existing installations.
CREATE TABLE published_page_links (
 workspace_id text NOT NULL,
 page_id text NOT NULL,
 version integer NOT NULL CHECK(version > 0),
 target_page_id text NOT NULL,
 PRIMARY KEY(workspace_id,page_id,target_page_id),
 FOREIGN KEY(workspace_id,page_id) REFERENCES pages(workspace_id,id) ON DELETE CASCADE
);
CREATE INDEX published_page_links_backlinks ON published_page_links(workspace_id,target_page_id,page_id);
