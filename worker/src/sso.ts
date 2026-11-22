import { Hono } from 'hono';
import type { Env } from './types';
import { issueToken } from './auth';
import { requireAuth } from './middleware';
import { bumpLimit } from './limits';

const OTT_TTL = 120;
// 未鉴权的兑换接口按 IP 限流：OTT 本身 128 位随机不可猜测，此处仅防刷接口消耗资源
const OTT_EXCHANGE_LIMIT = 60;
const OTT_EXCHANGE_TTL = 3600;

function randomId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export const ssoRoutes = new Hono<{ Bindings: Env; Variables: { userId: number; email: string } }>();

// 扩展凭据换取一次性令牌（供 Web 端自动登录）
ssoRoutes.post('/ott', requireAuth, async (c) => {
  const ott = randomId();
  await c.env.KV.put(`ott:${ott}`, String(c.get('userId')), { expirationTtl: OTT_TTL });
  return c.json({ ok: true, ott, expiresIn: OTT_TTL });
});

ssoRoutes.post('/exchange', async (c) => {
  const ip =
    c.req.header('CF-Connecting-IP') || c.req.header('X-Forwarded-For')?.split(',')[0]?.trim() || 'unknown';
  const limited = await bumpLimit(c.env, `ottx:${ip}`, OTT_EXCHANGE_LIMIT, OTT_EXCHANGE_TTL);
  if (limited.exceeded) {
    return c.json({ error: '请求过于频繁，请稍后再试' }, 429);
  }

  const body = await c.req.json().catch(() => ({}));
  const ott = typeof body.ott === 'string' ? body.ott.trim() : '';
  if (!/^[0-9a-f]{32}$/.test(ott)) return c.json({ error: '令牌无效' }, 400);

  const userId = Number(await c.env.KV.get(`ott:${ott}`));
  await c.env.KV.delete(`ott:${ott}`); // 一次性，立即作废
  if (!Number.isInteger(userId) || userId <= 0) {
    return c.json({ error: '令牌无效或已过期' }, 401);
  }

  const user = await c.env.DB.prepare('SELECT id, email FROM users WHERE id = ?')
    .bind(userId)
    .first<{ id: number; email: string }>();
  if (!user) return c.json({ error: '用户不存在' }, 401);

  const token = await issueToken(c.env, user);
  return c.json({ ok: true, token, email: user.email });
});
