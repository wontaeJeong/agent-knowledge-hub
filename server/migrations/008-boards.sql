-- Space-scoped announcements, reviewer discussion and private VOC.
-- No cross-workspace foreign key can point at a post.
CREATE TABLE board_posts (
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  id text NOT NULL,
  author_id text NOT NULL,
  kind text NOT NULL CHECK(kind IN ('notice','internal','voc')),
  visibility text NOT NULL CHECK(visibility IN ('team','private')),
  title text NOT NULL CHECK(length(title) BETWEEN 1 AND 160),
  body text NOT NULL CHECK(length(body) BETWEEN 1 AND 20000),
  status text NOT NULL DEFAULT 'open' CHECK(status IN ('open','in_progress','resolved')),
  pinned boolean NOT NULL DEFAULT false,
  revision integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(workspace_id,id),
  CHECK(visibility='team' OR kind='voc')
);
CREATE INDEX board_posts_recent ON board_posts(workspace_id,pinned DESC,created_at DESC);
CREATE TABLE board_comments (
  workspace_id text NOT NULL,
  post_id text NOT NULL,
  id text NOT NULL,
  author_id text NOT NULL,
  body text NOT NULL CHECK(length(body) BETWEEN 1 AND 10000),
  internal boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(workspace_id,post_id,id),
  FOREIGN KEY(workspace_id,post_id) REFERENCES board_posts(workspace_id,id) ON DELETE CASCADE
);
CREATE TABLE board_reads (
  workspace_id text NOT NULL,
  post_id text NOT NULL,
  principal_id text NOT NULL,
  read_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(workspace_id,post_id,principal_id),
  FOREIGN KEY(workspace_id,post_id) REFERENCES board_posts(workspace_id,id) ON DELETE CASCADE
);
