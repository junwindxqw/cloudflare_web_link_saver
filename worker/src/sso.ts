import { Hono } from 'hono';
import { sign } from 'hono/jwt';
import type { Env, UserPayload } from './types';
import { TOKEN_TTL_SECONDS } from './types';
import { requireAuth } from './middleware';

const OTT_TTL = 120;

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

  const now = Math.floor(Date.now() / 1000);
  const payload: UserPayload = { sub: String(user.id), email: user.email, iat: now, exp: now + TOKEN_TTL_SECONDS };
  const token = await sign(payload, c.env.JWT_SECRET, 'HS256');
  return c.json({ ok: true, token, email: user.email });
});
