-- 迁移：新增选中内容收藏（短文本 / 图片）
-- 执行：npx wrangler d1 execute link-saver-db --remote --file=migrations/0002_snippets.sql
CREATE TABLE IF NOT EXISTS snippets (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id      INTEGER NOT NULL,
  type         TEXT NOT NULL CHECK (type IN ('text', 'image')),
  content      TEXT NOT NULL DEFAULT '',
  storage_key  TEXT NOT NULL DEFAULT '',
  mime         TEXT NOT NULL DEFAULT '',
  bytes        INTEGER NOT NULL DEFAULT 0,
  source_url   TEXT NOT NULL DEFAULT '',
  source_title TEXT NOT NULL DEFAULT '',
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_snippets_user_type_time ON snippets (user_id, type, created_at DESC);
