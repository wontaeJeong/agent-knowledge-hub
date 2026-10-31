-- Policy metadata is not part of the immutable source body/snapshot.
CREATE TABLE access_source_policy (
 workspace_id text NOT NULL, source_id text NOT NULL,
 local_copy_allowed boolean NOT NULL DEFAULT false, export_allowed boolean NOT NULL DEFAULT false,
 revision integer NOT NULL DEFAULT 1,
 PRIMARY KEY(workspace_id,source_id), FOREIGN KEY(workspace_id,source_id) REFERENCES sources(workspace_id,id)
);
