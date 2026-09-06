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
    c.set('userId', userId);
    c.set('email', String(payload.email || ''));
    await next();
  },
);
