import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { Env } from './types';
import { authRoutes } from './auth';
import { linkRoutes } from './links';
import { snippetRoutes } from './snippets';
import { ssoRoutes } from './sso';

const EXTENSION_ORIGIN = 'chrome-extension://ojokkllejggilcghafadekmldpgcmphd';

const app = new Hono<{ Bindings: Env }>();

// Web 端与页面同源；扩展通过 host_permissions 直连。此处仍放开 CORS 以兼容扩展来源，
// 仅回显白名单内的来源（自身扩展 ID / Web 域名 / 本地开发），绝不返回通配符。
app.use(
  '/api/*',
  cors({
    origin: (origin, c) => {
      if (origin === c.env.WEB_ORIGIN) return origin;
      if (origin === EXTENSION_ORIGIN) return origin;
      if (/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) return origin; // 本地开发
      return undefined;
    },
    allowMethods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
    allowHeaders: ['Content-Type', 'Authorization'],
    maxAge: 86400,
  }),
);

app.route('/api/auth', authRoutes);
app.route('/api/links', linkRoutes);
app.route('/api/snippets', snippetRoutes);
app.route('/api/sso', ssoRoutes);

app.get('/api/health', (c) => c.json({ ok: true, time: new Date().toISOString() }));

app.notFound((c) => c.json({ error: 'Not Found' }, 404));
app.onError((err, c) => {
  console.error('unhandled error', err);
  return c.json({ error: '服务器内部错误' }, 500);
});

export default app;
