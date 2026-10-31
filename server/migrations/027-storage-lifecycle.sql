-- Stable authenticated attachment slots, immutable file versions and durable reviewed-import effects.
CREATE TABLE storage_attachment_slots (
 workspace_id text NOT NULL REFERENCES workspaces(id), id text NOT NULL,
 parent_kind text NOT NULL CHECK(parent_kind IN ('source','page')), parent_id text NOT NULL,
 head_id text NOT NULL, revision integer NOT NULL CHECK(revision>0), withdrawn boolean NOT NULL DEFAULT false,
 PRIMARY KEY(workspace_id,id),
 FOREIGN KEY(workspace_id,parent_kind,parent_id) REFERENCES resources(workspace_id,kind,id),
 FOREIGN KEY(workspace_id,head_id) REFERENCES storage_blobs(workspace_id,id)
);
CREATE TABLE storage_attachment_versions (
 workspace_id text NOT NULL, slot_id text NOT NULL, revision integer NOT NULL CHECK(revision>0), blob_id text NOT NULL,
 PRIMARY KEY(workspace_id,slot_id,revision), UNIQUE(workspace_id,blob_id),
 FOREIGN KEY(workspace_id,slot_id) REFERENCES storage_attachment_slots(workspace_id,id),
 FOREIGN KEY(workspace_id,blob_id) REFERENCES storage_blobs(workspace_id,id)
);
INSERT INTO storage_attachment_slots(workspace_id,id,parent_kind,parent_id,head_id,revision)
 SELECT workspace_id,id,parent_kind,parent_id,id,1 FROM storage_blobs;
INSERT INTO storage_attachment_versions(workspace_id,slot_id,revision,blob_id)
 SELECT workspace_id,id,1,id FROM storage_blobs;
CREATE TABLE storage_import_sources (
 workspace_id text NOT NULL, import_id text NOT NULL, original_id text NOT NULL, target_id text NOT NULL, content_hash text NOT NULL,
 PRIMARY KEY(workspace_id,import_id,original_id),
 FOREIGN KEY(workspace_id,import_id) REFERENCES storage_imports(workspace_id,id),
 FOREIGN KEY(workspace_id,target_id) REFERENCES sources(workspace_id,id)
);
CREATE TABLE storage_import_effects (
 workspace_id text NOT NULL, import_id text NOT NULL, principal_id text NOT NULL, request_hash text NOT NULL,
 batch_id text NOT NULL, batch_hash text NOT NULL, result jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(workspace_id,import_id),
 FOREIGN KEY(workspace_id,import_id) REFERENCES storage_imports(workspace_id,id),
 FOREIGN KEY(workspace_id,batch_id) REFERENCES batches(workspace_id,id)
);
CREATE TABLE storage_attachment_links (
 workspace_id text NOT NULL, slot_id text NOT NULL, blob_id text NOT NULL, page_id text NOT NULL, base_version integer NOT NULL,
 batch_id text NOT NULL, batch_hash text NOT NULL,
 PRIMARY KEY(workspace_id,slot_id,blob_id,page_id,base_version),
 FOREIGN KEY(workspace_id,slot_id) REFERENCES storage_attachment_slots(workspace_id,id),
 FOREIGN KEY(workspace_id,blob_id) REFERENCES storage_blobs(workspace_id,id),
 FOREIGN KEY(workspace_id,page_id) REFERENCES pages(workspace_id,id),
 FOREIGN KEY(workspace_id,batch_id) REFERENCES batches(workspace_id,id)
);
