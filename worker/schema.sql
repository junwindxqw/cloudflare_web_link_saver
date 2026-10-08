-- Link Saver 数据库结构（Cloudflare D1 / SQLite）

CREATE TABLE IF NOT EXISTS users (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  email          TEXT NOT NULL UNIQUE,
  password_hash  TEXT,
  email_verified INTEGER NOT NULL DEFAULT 0,
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS links (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL,
  url        TEXT NOT NULL,
  title      TEXT NOT NULL DEFAULT '',
  domain     TEXT NOT NULL,
  type       TEXT NOT NULL CHECK (type IN ('site', 'article')),
  category   TEXT NOT NULL,
  note       TEXT NOT NULL DEFAULT '',  -- 用户备注名称，可空
  tag        TEXT NOT NULL DEFAULT '',  -- 属性标签（规则识别，可手动改），可空
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (user_id, url)
);

CREATE INDEX IF NOT EXISTS idx_links_user_type_time ON links (user_id, type, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_links_user_category ON links (user_id, category);
CREATE INDEX IF NOT EXISTS idx_links_user_domain ON links (user_id, domain);

-- 网页中选中的内容：短文本（type=text）/ 图片（type=image）
CREATE TABLE IF NOT EXISTS snippets (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id      INTEGER NOT NULL,
  type         TEXT NOT NULL CHECK (type IN ('text', 'image')),
  content      TEXT NOT NULL DEFAULT '',  -- 文本内容；图片为原始 src（data: URL 不落库，转存 KV 后留空）
  storage_key  TEXT NOT NULL DEFAULT '',  -- 图片在 KV 中的键（img:<sha256>），转存失败时为空（回退外链）
  mime         TEXT NOT NULL DEFAULT '',
  bytes        INTEGER NOT NULL DEFAULT 0,
  source_url   TEXT NOT NULL DEFAULT '',  -- 来源页面
  source_title TEXT NOT NULL DEFAULT '',
  note         TEXT NOT NULL DEFAULT '',  -- 用户备注名称，与链接备注一致，可按备注筛选
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_snippets_user_type_time ON snippets (user_id, type, created_at DESC);
