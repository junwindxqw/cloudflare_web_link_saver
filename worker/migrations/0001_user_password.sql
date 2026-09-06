-- 迁移：新增密码登录（密码哈希 + 邮箱验证标记）
-- 执行：npx wrangler d1 execute link-saver-db --remote --file=migrations/0001_user_password.sql
ALTER TABLE users ADD COLUMN password_hash TEXT;
ALTER TABLE users ADD COLUMN email_verified INTEGER NOT NULL DEFAULT 0;
