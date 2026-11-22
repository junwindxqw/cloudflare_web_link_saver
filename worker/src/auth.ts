import { Hono } from 'hono';
import type { Context } from 'hono';
import { sign } from 'hono/jwt';
import type { Env, UserPayload } from './types';
import { TOKEN_TTL_SECONDS } from './types';
import { sendCodeEmail, type CodePurpose } from './email';
import { requireAuth } from './middleware';
import { hashPassword, validatePassword, verifyPassword } from './password';
import { bumpLimit, clearLimit, peekLimit } from './limits';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const CODE_TTL = 600;
const MAX_ATTEMPTS = 5;
const SEND_COOLDOWN = 60;
const IP_DAILY_LIMIT = 30;
const LOGIN_FAIL_LIMIT = 10;
const LOGIN_FAIL_TTL = 900;

// 验证码只存码值与有效期；错误尝试次数在 rate_limits 表（D1 原子自增）里累计
type CodeRecord = { code: string; expiresAt: number };
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

// 常量时间比较验证码（长度先比对：两侧行长度固定 6 位，不泄露额外信息）
function codeEqual(a: string, b: string): boolean {
  const ea = new TextEncoder().encode(a);
  const eb = new TextEncoder().encode(b);
  if (ea.length !== eb.length) return false;
  let diff = 0;
  for (let i = 0; i < ea.length; i++) diff |= ea[i] ^ eb[i];
  return diff === 0;
}

export async function issueToken(env: Env, user: UserInfo): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const payload: UserPayload = { sub: String(user.id), email: user.email, iat: now, exp: now + TOKEN_TTL_SECONDS };
  return sign(payload, env.JWT_SECRET, 'HS256');
}

type SendResult = { ok: true; message: string } | { ok: false; status: 429 | 502; error: string };

// 邮箱验证码签发：登录 / 注册 / 找回密码三种用途各自独立（记录与冷却键互不干扰）
async function sendCode(c: Context<{ Bindings: Env }>, email: string, purpose: CodePurpose): Promise<SendResult> {
  const env = c.env;
  const ip =
    c.req.header('CF-Connecting-IP') || c.req.header('X-Forwarded-For')?.split(',')[0]?.trim() || 'unknown';
  const today = new Date().toISOString().slice(0, 10);
  // 冷却（limit=1 的计数即开关）与 IP 每日上限都是 D1 原子计数，并发下不会漏判
  const [cooldown, ipLimit] = await Promise.all([
    bumpLimit(env, `code:cd:${purpose}:${email}`, 1, SEND_COOLDOWN),
    bumpLimit(env, `code:ip:${ip}:${today}`, IP_DAILY_LIMIT, 86400),
  ]);
  if (cooldown.exceeded) {
    return { ok: false, status: 429, error: '发送过于频繁，请 1 分钟后再试' };
  }
  if (ipLimit.exceeded) {
    // 每日上限不打冷却，明日窗口自动清零
    await clearLimit(env, `code:cd:${purpose}:${email}`).catch(() => {});
    return { ok: false, status: 429, error: '今日发送次数已达上限，请明天再试' };
  }

  const record: CodeRecord = { code: randomCode(), expiresAt: Date.now() + CODE_TTL * 1000 };
  // 先落码再发信：发送失败时验证码保留至自然过期（本地测试也依赖可从 KV 读码）
  await env.KV.put(`code:${purpose}:${email}`, JSON.stringify(record), { expirationTtl: CODE_TTL });
  try {
    await sendCodeEmail(env, email, record.code, purpose);
  } catch (e) {
    console.error(`send ${purpose} email failed`, e);
    // 发送失败仅释放冷却让用户可立即重试
    await clearLimit(env, `code:cd:${purpose}:${email}`).catch(() => {});
    return { ok: false, status: 502, error: '验证码邮件发送失败，请稍后重试' };
  }
  return { ok: true, message: '验证码已发送，10 分钟内有效' };
}

// 校验并消费验证码：错误次数超过上限即作废；正确则一次性删除
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
  if (codeEqual(record.code, code)) {
    await Promise.all([env.KV.delete(key), clearLimit(env, `codeatt:${purpose}:${email}`)]);
    return true;
  }
  // 错误尝试计数走 D1 原子自增；超过上限作废验证码
  const ttl = Math.max(1, Math.floor((record.expiresAt - Date.now()) / 1000));
  const r = await bumpLimit(env, `codeatt:${purpose}:${email}`, MAX_ATTEMPTS, ttl);
  if (r.exceeded) await env.KV.delete(key);
  return false;
}

async function ensureUser(env: Env, email: string): Promise<UserInfo> {
  // 命中即返回新用户 id，免去插入后的第二次查询；冲突（已存在）时再走 SELECT
  const inserted = await env.DB.prepare(
    'INSERT INTO users (email, email_verified) VALUES (?, 1) ON CONFLICT(email) DO NOTHING RETURNING id',
  )
    .bind(email)
    .first<{ id: number }>();
  if (inserted) return { id: inserted.id, email };
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
  // 对已注册邮箱不发信也不报 409，与找回密码流程保持一致，避免泄露邮箱是否已注册
  const exists = await c.env.DB.prepare('SELECT 1 FROM users WHERE email = ?').bind(email).first();
  if (!exists) {
    const r = await sendCode(c, email, 'register');
    if (!r.ok) return c.json({ error: r.error }, r.status);
  }
  return c.json({ ok: true, message: '如果该邮箱未注册，注册验证码已发送，10 分钟内有效' });
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
  // password_changed_at：密码吊销锚点，早于它签发的 JWT 全部失效
  const ins = await c.env.DB.prepare(
    "INSERT INTO users (email, password_hash, email_verified, password_changed_at) VALUES (?, ?, 1, strftime('%s','now'))",
  )
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
  // 只读预检提前短路（省掉密码哈希的 CPU）；权威判定在失败后的原子自增里
  if ((await peekLimit(c.env, failKey, LOGIN_FAIL_LIMIT)).exceeded) {
    return c.json({ error: '失败次数过多，请 15 分钟后再试，或改用验证码登录' }, 429);
  }

  if (!(await verifyPassword(password, user.password_hash))) {
    const fails = await bumpLimit(c.env, failKey, LOGIN_FAIL_LIMIT, LOGIN_FAIL_TTL);
    return c.json(
      { error: fails.count >= LOGIN_FAIL_LIMIT ? '失败次数过多，请 15 分钟后再试，或改用验证码登录' : '邮箱或密码不正确' },
      401,
    );
  }
  await clearLimit(c.env, failKey);
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
  // 正常流程下消费验证码已保证账号存在；行缺失（注册后被删）与码错共用同一提示
  if (!user) return c.json({ error: '验证码不正确或已过期' }, 400);
  const passwordHash = await hashPassword(body.new_password as string);
  // 重置密码吊销所有旧令牌（包括盗取者手里的），并给当前用户签发新令牌
  await c.env.DB.prepare("UPDATE users SET password_hash = ?, password_changed_at = strftime('%s','now') WHERE id = ?")
    .bind(passwordHash, user.id)
    .run();
  const token = await issueToken(c.env, user);
  return c.json({ ok: true, token, email: user.email });
});

// ---- 修改密码（已登录状态；未设置过密码的账号可直接设置）----

const CHANGE_FAIL_LIMIT = 5;
const CHANGE_FAIL_TTL = 900;

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
    // 防爆破：同账号连续验证旧密码失败即锁定（与密码登录同一策略）
    const failKey = `pwchg:fail:${c.get('userId')}`;
    if ((await peekLimit(c.env, failKey, CHANGE_FAIL_LIMIT)).exceeded) {
      return c.json({ error: '尝试次数过多，请 15 分钟后再试' }, 429);
    }
    if (!(await verifyPassword(oldPassword, storedHash))) {
      const fails = await bumpLimit(c.env, failKey, CHANGE_FAIL_LIMIT, CHANGE_FAIL_TTL);
      return c.json(
        { error: fails.count >= CHANGE_FAIL_LIMIT ? '尝试次数过多，请 15 分钟后再试' : '当前密码不正确' },
        fails.count >= CHANGE_FAIL_LIMIT ? 429 : 400,
      );
    }
    await clearLimit(c.env, failKey).catch(() => {});
  }

  const passwordHash = await hashPassword(body.new_password as string);
  // 吊销包括当前令牌在内的全部旧令牌，同时签发新令牌让当前会话保持登录
  await c.env.DB.prepare("UPDATE users SET password_hash = ?, password_changed_at = strftime('%s','now') WHERE id = ?")
    .bind(passwordHash, user.id)
    .run();
  const token = await issueToken(c.env, { id: user.id, email: c.get('email') });
  return c.json({ ok: true, message: hadPassword ? '密码已修改' : '密码已设置', token });
});

// ---- 当前用户 ----

authRoutes.get('/me', requireAuth, async (c) => {
  const userId = c.get('userId');
  // 用户信息与两类计数互不依赖，并行查询
  const [user, counts] = await Promise.all([
    c.env.DB.prepare('SELECT id, email, created_at, password_hash FROM users WHERE id = ?')
      .bind(userId)
      .first<{ id: number; email: string; created_at: string; password_hash: string | null }>(),
    c.env.DB.prepare(
      `SELECT
         (SELECT COUNT(*) FROM links WHERE user_id = ?1 AND type = 'site') AS siteCount,
         (SELECT COUNT(*) FROM links WHERE user_id = ?1 AND type = 'article') AS articleCount`,
    )
      .bind(userId)
      .first<{ siteCount: number; articleCount: number }>(),
  ]);
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
