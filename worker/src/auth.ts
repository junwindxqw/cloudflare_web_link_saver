import { Hono } from 'hono';
import type { Context } from 'hono';
import { sign } from 'hono/jwt';
import type { Env, UserPayload } from './types';
import { TOKEN_TTL_SECONDS } from './types';
import { sendCodeEmail, type CodePurpose } from './email';
import { requireAuth } from './middleware';
import { hashPassword, validatePassword, verifyPassword } from './password';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const CODE_TTL = 600;
const MAX_ATTEMPTS = 5;
const SEND_COOLDOWN = 60;
const IP_DAILY_LIMIT = 30;
const LOGIN_FAIL_LIMIT = 10;
const LOGIN_FAIL_TTL = 900;

type CodeRecord = { code: string; attempts: number; expiresAt: number };
type UserInfo = { id: number; email: string };

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

async function issueToken(env: Env, user: UserInfo): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const payload: UserPayload = { sub: String(user.id), email: user.email, iat: now, exp: now + TOKEN_TTL_SECONDS };
  return sign(payload, env.JWT_SECRET, 'HS256');
}

type SendResult = { ok: true; message: string } | { ok: false; status: 429 | 502; error: string };

// 邮箱验证码签发：登录 / 注册 / 找回密码三种用途各自独立（记录与冷却键互不干扰）
async function sendCode(c: Context<{ Bindings: Env }>, email: string, purpose: CodePurpose): Promise<SendResult> {
  const env = c.env;
  const cooldownKey = `code:cd:${purpose}:${email}`;
  if (await env.KV.get(cooldownKey)) {
    return { ok: false, status: 429, error: '发送过于频繁，请 1 分钟后再试' };
  }
  const ip =
    c.req.header('CF-Connecting-IP') || c.req.header('X-Forwarded-For')?.split(',')[0]?.trim() || 'unknown';
  const ipKey = `code:ip:${ip}:${new Date().toISOString().slice(0, 10)}`;
  const sent = Number((await env.KV.get(ipKey)) || 0);
  if (sent >= IP_DAILY_LIMIT) {
    return { ok: false, status: 429, error: '今日发送次数已达上限，请明天再试' };
  }

  const record: CodeRecord = { code: randomCode(), attempts: 0, expiresAt: Date.now() + CODE_TTL * 1000 };
  await env.KV.put(`code:${purpose}:${email}`, JSON.stringify(record), { expirationTtl: CODE_TTL });
  await env.KV.put(cooldownKey, '1', { expirationTtl: SEND_COOLDOWN });
  await env.KV.put(ipKey, String(sent + 1), { expirationTtl: 86400 });

  try {
    await sendCodeEmail(env, email, record.code, purpose);
  } catch (e) {
    console.error(`send ${purpose} email failed`, e);
    // 发送失败仅释放冷却让用户可立即重试；验证码保留至自然过期
    await env.KV.delete(cooldownKey).catch(() => {});
    return { ok: false, status: 502, error: '验证码邮件发送失败，请稍后重试' };
  }
  return { ok: true, message: '验证码已发送，10 分钟内有效' };
}

// 校验并消费验证码：错误累计次数，超过上限作废；正确则一次性删除
async function consumeCode(env: Env, email: string, purpose: CodePurpose, code: string): Promise<boolean> {
  const key = `code:${purpose}:${email}`;
  const raw = await env.KV.get(key);
  if (!raw) return false;
  let record: CodeRecord;
  try {
    record = JSON.parse(raw) as CodeRecord;
  } catch {
    return false;
  }
  if (record.attempts >= MAX_ATTEMPTS) {
    await env.KV.delete(key);
    return false;
  }
  if (record.code !== code) {
    const ttl = Math.max(1, Math.floor((record.expiresAt - Date.now()) / 1000));
    await env.KV.put(key, JSON.stringify({ ...record, attempts: record.attempts + 1 }), { expirationTtl: ttl });
    return false;
  }
  await env.KV.delete(key);
  return true;
}

async function ensureUser(env: Env, email: string): Promise<UserInfo> {
  await env.DB.prepare('INSERT INTO users (email, email_verified) VALUES (?, 1) ON CONFLICT(email) DO NOTHING')
    .bind(email)
    .run();
  const user = await env.DB.prepare('SELECT id, email FROM users WHERE email = ?')
    .bind(email)
    .first<UserInfo>();
  if (!user) throw new Error('用户创建失败');
  return user;
}

export const authRoutes = new Hono<{ Bindings: Env }>();

// ---- 验证码登录（未注册邮箱会自动创建账号，即免注册登录）----

authRoutes.post('/request-code', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const email = normalizeEmail(body.email);
  if (!email) return c.json({ error: '请输入正确的邮箱地址' }, 400);
  const r = await sendCode(c, email, 'login');
  return r.ok ? c.json(r) : c.json({ error: r.error }, r.status);
});

authRoutes.post('/verify', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const email = normalizeEmail(body.email);
  const code = typeof body.code === 'string' ? body.code.trim() : '';
  if (!email || !/^\d{6}$/.test(code)) {
    return c.json({ error: '请输入正确的邮箱和 6 位验证码' }, 400);
  }
  if (!(await consumeCode(c.env, email, 'login', code))) {
    return c.json({ error: '验证码不正确或已过期' }, 400);
  }
  const user = await ensureUser(c.env, email);
  const token = await issueToken(c.env, user);
  return c.json({ ok: true, token, email: user.email });
});

// ---- 注册（邮箱 + 密码 + 邮箱验证码）----

authRoutes.post('/register/request-code', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const email = normalizeEmail(body.email);
  if (!email) return c.json({ error: '请输入正确的邮箱地址' }, 400);
  const exists = await c.env.DB.prepare('SELECT 1 FROM users WHERE email = ?').bind(email).first();
  if (exists) return c.json({ error: '该邮箱已注册，请直接登录或找回密码' }, 409);
  const r = await sendCode(c, email, 'register');
  return r.ok ? c.json(r) : c.json({ error: r.error }, r.status);
});

authRoutes.post('/register', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const email = normalizeEmail(body.email);
  const code = typeof body.code === 'string' ? body.code.trim() : '';
  const pwError = validatePassword(body.password);
  if (!email) return c.json({ error: '请输入正确的邮箱地址' }, 400);
  if (pwError) return c.json({ error: pwError }, 400);
  if (!/^\d{6}$/.test(code)) return c.json({ error: '请输入 6 位邮箱验证码' }, 400);

  if (!(await consumeCode(c.env, email, 'register', code))) {
    return c.json({ error: '验证码不正确或已过期' }, 400);
  }
  const passwordHash = await hashPassword(body.password as string);
  const ins = await c.env.DB.prepare('INSERT INTO users (email, password_hash, email_verified) VALUES (?, ?, 1)')
    .bind(email, passwordHash)
    .run();
  if (!ins.meta.changes) return c.json({ error: '该邮箱已注册，请直接登录' }, 409);
  const token = await issueToken(c.env, { id: Number(ins.meta.last_row_id), email });
  return c.json({ ok: true, token, email });
});

// ---- 密码登录 ----

authRoutes.post('/login', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const email = normalizeEmail(body.email);
  const password = typeof body.password === 'string' ? body.password : '';
  if (!email || !password) return c.json({ error: '请输入邮箱和密码' }, 400);

  const user = await c.env.DB.prepare('SELECT id, email, password_hash FROM users WHERE email = ?')
    .bind(email)
    .first<{ id: number; email: string; password_hash: string | null }>();
  if (!user?.password_hash) {
    return c.json({ error: '该账号未设置密码，请使用验证码登录，或通过「忘记密码」设置密码' }, 401);
  }

  const failKey = `pw:fail:${email}`;
  const failsRaw = await c.env.KV.get(failKey);
  const fails = failsRaw ? (JSON.parse(failsRaw) as { count: number }) : { count: 0 };
  if (fails.count >= LOGIN_FAIL_LIMIT) {
    return c.json({ error: '失败次数过多，请 15 分钟后再试，或改用验证码登录' }, 429);
  }

  if (!(await verifyPassword(password, user.password_hash))) {
    const count = fails.count + 1;
    await c.env.KV.put(failKey, JSON.stringify({ count }), { expirationTtl: LOGIN_FAIL_TTL });
    return c.json(
      { error: count >= LOGIN_FAIL_LIMIT ? '失败次数过多，请 15 分钟后再试，或改用验证码登录' : '邮箱或密码不正确' },
      401,
    );
  }
  await c.env.KV.delete(failKey);
  const token = await issueToken(c.env, { id: user.id, email: user.email });
  return c.json({ ok: true, token, email: user.email });
});

// ---- 找回密码（重置验证码 + 新密码）----

authRoutes.post('/reset/request-code', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const email = normalizeEmail(body.email);
  if (!email) return c.json({ error: '请输入正确的邮箱地址' }, 400);
  // 仅对已注册邮箱发信，但对外响应保持一致，避免账号枚举
  const exists = await c.env.DB.prepare('SELECT 1 FROM users WHERE email = ?').bind(email).first();
  if (exists) {
    const r = await sendCode(c, email, 'reset');
    if (!r.ok) return c.json({ error: r.error }, r.status);
  }
  return c.json({ ok: true, message: '如果该邮箱已注册，重置验证码已发送，10 分钟内有效' });
});

authRoutes.post('/reset-password', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const email = normalizeEmail(body.email);
  const code = typeof body.code === 'string' ? body.code.trim() : '';
  const pwError = validatePassword(body.new_password);
  if (!email) return c.json({ error: '请输入正确的邮箱地址' }, 400);
  if (pwError) return c.json({ error: pwError }, 400);
  if (!/^\d{6}$/.test(code)) return c.json({ error: '请输入 6 位重置验证码' }, 400);

  if (!(await consumeCode(c.env, email, 'reset', code))) {
    return c.json({ error: '验证码不正确或已过期' }, 400);
  }
  const user = await c.env.DB.prepare('SELECT id, email FROM users WHERE email = ?')
    .bind(email)
    .first<UserInfo>();
  if (!user) return c.json({ error: '账号不存在' }, 400);
  const passwordHash = await hashPassword(body.new_password as string);
  await c.env.DB.prepare('UPDATE users SET password_hash = ? WHERE id = ?').bind(passwordHash, user.id).run();
  const token = await issueToken(c.env, user);
  return c.json({ ok: true, token, email: user.email });
});

// ---- 修改密码（已登录状态；未设置过密码的账号可直接设置）----

authRoutes.post('/change-password', requireAuth, async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const pwError = validatePassword(body.new_password);
  if (pwError) return c.json({ error: pwError }, 400);

  const user = await c.env.DB.prepare('SELECT id, password_hash FROM users WHERE id = ?')
    .bind(c.get('userId'))
    .first<{ id: number; password_hash: string | null }>();
  if (!user) return c.json({ error: '用户不存在' }, 401);

  const storedHash = user.password_hash;
  const hadPassword = typeof storedHash === 'string' && storedHash.length > 0;
  if (hadPassword) {
    const oldPassword = typeof body.old_password === 'string' ? body.old_password : '';
    if (!oldPassword) return c.json({ error: '请输入当前密码' }, 400);
    if (!(await verifyPassword(oldPassword, storedHash))) {
      return c.json({ error: '当前密码不正确' }, 400);
    }
  }

  const passwordHash = await hashPassword(body.new_password as string);
  await c.env.DB.prepare('UPDATE users SET password_hash = ? WHERE id = ?')
    .bind(passwordHash, user.id)
    .run();
  return c.json({ ok: true, message: hadPassword ? '密码已修改' : '密码已设置' });
});

// ---- 当前用户 ----

authRoutes.get('/me', requireAuth, async (c) => {
  const userId = c.get('userId');
  const user = await c.env.DB.prepare('SELECT id, email, created_at, password_hash FROM users WHERE id = ?')
    .bind(userId)
    .first<{ id: number; email: string; created_at: string; password_hash: string | null }>();
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
    hasPassword: Boolean(user?.password_hash),
    siteCount: counts?.siteCount ?? 0,
    articleCount: counts?.articleCount ?? 0,
  });
});
