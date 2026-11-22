-- 0006: 安全与性能优化
-- 适用：执行过 0001-0005 的既有数据库；全新部署直接跑 schema.sql 即可，不需要本文件。

-- 1) 密码吊销锚点：修改 / 重置密码后，早于该时间签发的 JWT 一律失效
ALTER TABLE users ADD COLUMN password_changed_at INTEGER;
-- 已设置密码的存量用户立即生效（无密码的验证码登录账号保持 NULL，不受影响）
UPDATE users SET password_changed_at = CAST(strftime('%s', 'now') AS INTEGER)
WHERE password_hash IS NOT NULL AND password_hash != '';

-- 2) 认证限流计数表：单条 UPSERT ... RETURNING 原子自增，替代 KV 读-改-写的竞态实现
CREATE TABLE IF NOT EXISTS rate_limits (
  key      TEXT PRIMARY KEY,
  count    INTEGER NOT NULL DEFAULT 0,
  reset_at INTEGER NOT NULL
);

-- 3) 补齐高频查询的索引
-- 标签筛选 / 一键识别 / 标签聚合
CREATE INDEX IF NOT EXISTS idx_links_user_tag ON links (user_id, tag);
-- 备注筛选与备注聚合（链接）
CREATE INDEX IF NOT EXISTS idx_links_user_note ON links (user_id, note);
-- 备注筛选（片段）
CREATE INDEX IF NOT EXISTS idx_snippets_user_note ON snippets (user_id, note);
-- 不带类型过滤的列表与备注 / 标签混合视图按时间排序
CREATE INDEX IF NOT EXISTS idx_links_user_created ON links (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_snippets_user_created ON snippets (user_id, created_at DESC);
-- 删除图片时的引用计数查询（原先全表扫）
CREATE INDEX IF NOT EXISTS idx_snippets_storage_key ON snippets (storage_key);

-- 4) 清理无任何查询引用的旧索引（写路径净开销）
DROP INDEX IF EXISTS idx_links_user_domain;
