import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { Env } from './types';
import { authRoutes } from './auth';
import { linkRoutes } from './links';
import { snippetRoutes } from './snippets';
import { ssoRoutes } from './sso';

const app = new Hono<{ Bindings: Env }>();

// Web 端与页面同源；扩展通过 host_permissions 直连。此处仍放开 CORS 以兼容扩展来源，
// 仅回显白名单内的来源（扩展 ID / Web 域名 / 本地开发），绝不返回通配符。
app.use(
  '/api/*',
  cors({
    origin: (origin, c) => {
      if (origin === c.env.WEB_ORIGIN) return origin;
      if (c.env.EXTENSION_ORIGIN && origin === c.env.EXTENSION_ORIGIN) return origin;
      // 本地开发：仅在 .dev.vars 里显式设 ALLOW_LOCAL_ORIGIN=true 时放行，生产默认拒绝
      if (c.env.ALLOW_LOCAL_ORIGIN === 'true' && /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) {
        return origin;
      }
      return undefined;
    },
    allowMethods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    allowHeaders: ['Content-Type', 'Authorization'],
    maxAge: 86400,
  }),
);

// API 响应统一加固：防 MIME 嗅探 + 默认禁缓存（图片端点自带 private 缓存头，不覆盖）
app.use('/api/*', async (c, next) => {
  await next();
  c.res.headers.set('X-Content-Type-Options', 'nosniff');
  c.res.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  if (!c.res.headers.has('Cache-Control')) {
    c.res.headers.set('Cache-Control', 'no-store');
  }
});

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
