import { createMiddleware } from 'hono/factory';
import { verify } from 'hono/jwt';
import type { Env, UserPayload } from './types';

export const requireAuth = createMiddleware<{ Bindings: Env; Variables: { userId: number; email: string } }>(
  async (c, next) => {
    const header = c.req.header('Authorization') || '';
    const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
    if (!token) {
      return c.json({ error: '未登录' }, 401);
    }
    let payload: UserPayload;
    try {
      payload = (await verify(token, c.env.JWT_SECRET, 'HS256')) as UserPayload;
    } catch {
      return c.json({ error: '登录已过期，请重新登录' }, 401);
    }
    const userId = Number(payload.sub);
    if (!Number.isInteger(userId) || userId <= 0) {
      return c.json({ error: '登录已过期，请重新登录' }, 401);
    }
    // 吊销检查：修改 / 重置密码后，早于 password_changed_at 签发的令牌一律失效。
    // 用户行不存在时放行（与 /me 的容错一致）；无密码账号该列为 NULL，永不拒绝。
    const row = await c.env.DB.prepare('SELECT password_changed_at FROM users WHERE id = ?')
      .bind(userId)
      .first<{ password_changed_at: number | null }>();
    if (row && typeof row.password_changed_at === 'number' && payload.iat < row.password_changed_at) {
      return c.json({ error: '登录已过期，请重新登录' }, 401);
    }
    c.set('userId', userId);
    c.set('email', String(payload.email || ''));
    await next();
  },
);
