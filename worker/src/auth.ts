import { Hono } from 'hono';
import { sign } from 'hono/jwt';
import type { Env, UserPayload } from './types';
import { TOKEN_TTL_SECONDS } from './types';
import { sendVerificationEmail } from './email';
import { requireAuth } from './middleware';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const CODE_TTL = 600;
const MAX_ATTEMPTS = 5;

function normalizeEmail(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const email = raw.trim().toLowerCase();
  if (email.length > 254 || !EMAIL_RE.test(email)) return null;
  return email;
}

function randomCode(): string {
  // 拒绝采样消除模偏差：丢弃会折回区间开头的随机数
  const limit = Math.floor(0x100000000 / 1000000) * 1000000;
  const buf = new Uint32Array(1);
  let n: number;
  do {
    crypto.getRandomValues(buf);
    n = buf[0];
  } while (n >= limit);
  return String(n % 1000000).padStart(6, '0');
}

type CodeRecord = { code: string; attempts: number; expiresAt: number };

async function issueToken(env: Env, user: { id: number; email: string }): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const payload: UserPayload = { sub: String(user.id), email: user.email, iat: now, exp: now + TOKEN_TTL_SECONDS };
  return sign(payload, env.JWT_SECRET, 'HS256');
}

async function ensureUser(env: Env, email: string): Promise<{ id: number; email: string }> {
  await env.DB.prepare('INSERT INTO users(email) VALUES(?) ON CONFLICT(email) DO NOTHING').bind(email).run();
  const user = await env.DB.prepare('SELECT id, email FROM users WHERE email = ?')
    .bind(email)
    .first<{ id: number; email: string }>();
  if (!user) throw new Error('用户创建失败');
  return user;
}

export const authRoutes = new Hono<{ Bindings: Env }>();

authRoutes.post('/request-code', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const email = normalizeEmail(body.email);
  if (!email) return c.json({ error: '请输入正确的邮箱地址' }, 400);

  const ip =
    c.req.header('CF-Connecting-IP') || c.req.header('X-Forwarded-For')?.split(',')[0]?.trim() || 'unknown';
  const cooldownKey = `rc:cd:${email}`;
  if (await c.env.KV.get(cooldownKey)) {
    return c.json({ error: '发送过于频繁，请 1 分钟后再试' }, 429);
  }
  const ipDay = new Date().toISOString().slice(0, 10);
  const ipKey = `rc:ip:${ip}:${ipDay}`;
  const sent = Number((await c.env.KV.get(ipKey)) || 0);
  if (sent >= 20) {
    return c.json({ error: '今日发送次数已达上限，请明天再试' }, 429);
  }

  const code = randomCode();
  await c.env.KV.put(`rc:code:${email}`, JSON.stringify({ code, attempts: 0, expiresAt: Date.now() + CODE_TTL * 1000 }), {
    expirationTtl: CODE_TTL,
  });
  await c.env.KV.put(cooldownKey, '1', { expirationTtl: 60 });
  await c.env.KV.put(ipKey, String(sent + 1), { expirationTtl: 86400 });

  try {
    await sendVerificationEmail(c.env, email, code);
  } catch (e) {
    console.error('send email failed', e);
    // 发送失败即释放冷却与本次验证码，让用户可立即重试
    await c.env.KV.delete(cooldownKey).catch(() => {});
    await c.env.KV.delete(`rc:code:${email}`).catch(() => {});
    return c.json({ error: '验证码邮件发送失败，请稍后重试' }, 502);
  }
  return c.json({ ok: true, message: '验证码已发送，10 分钟内有效' });
});

authRoutes.post('/verify', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const email = normalizeEmail(body.email);
  const code = typeof body.code === 'string' ? body.code.trim() : '';
  if (!email || !/^\d{6}$/.test(code)) {
    return c.json({ error: '请输入正确的邮箱和 6 位验证码' }, 400);
  }

  const key = `rc:code:${email}`;
  const raw = await c.env.KV.get(key);
  if (!raw) {
    return c.json({ error: '验证码已过期，请重新获取' }, 400);
  }
  let record: CodeRecord;
  try {
    record = JSON.parse(raw) as CodeRecord;
  } catch {
    return c.json({ error: '验证码状态异常，请重新获取' }, 400);
  }

  if (record.attempts >= MAX_ATTEMPTS) {
    await c.env.KV.delete(key);
    return c.json({ error: '尝试次数过多，请重新获取验证码' }, 429);
  }
  if (record.code !== code) {
    const ttl = Math.max(1, Math.floor((record.expiresAt - Date.now()) / 1000));
    await c.env.KV.put(key, JSON.stringify({ ...record, attempts: record.attempts + 1 }), { expirationTtl: ttl });
    return c.json({ error: '验证码不正确' }, 400);
  }

  await c.env.KV.delete(key);
  const user = await ensureUser(c.env, email);
  const token = await issueToken(c.env, user);
  return c.json({ ok: true, token, email: user.email });
});

authRoutes.get('/me', requireAuth, async (c) => {
  const userId = c.get('userId');
  const user = await c.env.DB.prepare('SELECT id, email, created_at FROM users WHERE id = ?')
    .bind(userId)
    .first<{ id: number; email: string; created_at: string }>();
  const counts = await c.env.DB.prepare(
    `SELECT
       (SELECT COUNT(*) FROM links WHERE user_id = ?1 AND type = 'site') AS siteCount,
       (SELECT COUNT(*) FROM links WHERE user_id = ?1 AND type = 'article') AS articleCount`,
  )
    .bind(userId)
    .first<{ siteCount: number; articleCount: number }>();
  return c.json({
    ok: true,
    userId,
    email: user?.email ?? c.get('email'),
    registeredAt: user?.created_at ?? null,
    siteCount: counts?.siteCount ?? 0,
    articleCount: counts?.articleCount ?? 0,
  });
});
