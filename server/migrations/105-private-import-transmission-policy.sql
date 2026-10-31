-- Raw private imports are not registered sources and must never inherit upload consent.
CREATE TABLE policy_private_import_sources (
 workspace_id text NOT NULL, import_id text NOT NULL,
 revision integer NOT NULL CHECK(revision>0), import_revision integer NOT NULL,
 input_hash text NOT NULL, classification text NOT NULL, grants jsonb NOT NULL DEFAULT '[]',
 PRIMARY KEY(workspace_id,import_id),
 FOREIGN KEY(workspace_id,import_id) REFERENCES imports(workspace_id,id) ON DELETE CASCADE
);
