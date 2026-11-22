// 基于 D1 的原子限流计数。KV 的「读-改-写」在并发请求下会同时读到相同计数导致漏计，
// 这里改用单条 UPSERT ... RETURNING：SQLite 单语句天然原子，窗口到期后自动从 1 重新计数。

import type { Env } from './types';

export type LimitResult = { exceeded: boolean; count: number; retryAfterSec: number };

const nowSec = () => Math.floor(Date.now() / 1000);

/**
 * 原子自增计数并与上限比较，count 超过 limit 即 exceeded=true（调用方应拒绝请求）。
 * 窗口内重复自增；reset_at 过期后本条语句会自动重置为 1 并续期。
 */
export async function bumpLimit(env: Env, key: string, limit: number, ttlSec: number): Promise<LimitResult> {
  const now = nowSec();
  const resetAt = now + Math.max(1, ttlSec);
  const row = await env.DB.prepare(
    `INSERT INTO rate_limits (key, count, reset_at) VALUES (?1, 1, ?3)
     ON CONFLICT(key) DO UPDATE SET
       count = CASE WHEN reset_at <= ?2 THEN 1 ELSE count + 1 END,
       reset_at = CASE WHEN reset_at <= ?2 THEN ?3 ELSE reset_at END
     RETURNING count, reset_at`,
  )
    .bind(key, now, resetAt)
    .first<{ count: number; reset_at: number }>();
  const count = row?.count ?? 1;
  const expiringAt = row?.reset_at ?? resetAt;
  // 低概率顺带清理过期行，防止表无限膨胀（过期行即使残留也不影响计数逻辑）
  if (Math.random() < 0.02) {
    await env.DB.prepare('DELETE FROM rate_limits WHERE reset_at <= ?1').bind(now).run().catch(() => {});
  }
  return { exceeded: count > limit, count, retryAfterSec: Math.max(1, expiringAt - now) };
}

/** 只读预检：命中上限时提前短路（省掉 PBKDF2 等昂贵操作），权威判定仍以 bumpLimit 为准 */
export async function peekLimit(env: Env, key: string, limit: number): Promise<LimitResult> {
  const now = nowSec();
  const row = await env.DB.prepare('SELECT count, reset_at FROM rate_limits WHERE key = ?1')
    .bind(key)
    .first<{ count: number; reset_at: number }>();
  const count = row && row.reset_at > now ? row.count : 0;
  return { exceeded: count > limit, count, retryAfterSec: row ? Math.max(1, row.reset_at - now) : 0 };
}

/** 清零计数（验证成功 / 发送成功后调用，让窗口内后续操作不再被误伤） */
export async function clearLimit(env: Env, key: string): Promise<void> {
  await env.DB.prepare('DELETE FROM rate_limits WHERE key = ?1').bind(key).run();
}
