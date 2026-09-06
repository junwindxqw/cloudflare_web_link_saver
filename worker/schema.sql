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
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (user_id, url)
);

CREATE INDEX IF NOT EXISTS idx_links_user_type_time ON links (user_id, type, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_links_user_category ON links (user_id, category);
CREATE INDEX IF NOT EXISTS idx_links_user_domain ON links (user_id, domain);
