// 密码哈希：PBKDF2-HMAC-SHA256（WebCrypto，Workers 原生支持，无第三方依赖）
// 存储格式：pbkdf2$<iterations>$<salt_b64>$<hash_b64>，迭代次数随记录保存，可整体升级

const PBKDF2_ITERATIONS = 100000;

export function validatePassword(pw: unknown): string | null {
  if (typeof pw !== 'string' || !pw) return '请输入密码';
  if (pw.length < 8 || pw.length > 128) return '密码长度需为 8-128 位';
  if (!/[a-zA-Z]/.test(pw) || !/[0-9]/.test(pw)) return '密码需同时包含字母和数字';
  return null;
}

function toB64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

function fromB64(s: string): Uint8Array {
  return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
}

async function derive(password: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: salt as BufferSource, iterations },
    key,
    256,
  );
  return new Uint8Array(bits);
}

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await derive(password, salt, PBKDF2_ITERATIONS);
  return `pbkdf2$${PBKDF2_ITERATIONS}$${toB64(salt)}$${toB64(hash)}`;
}

function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 4 || parts[0] !== 'pbkdf2') return false;
  const iterations = Number(parts[1]);
  if (!Number.isInteger(iterations) || iterations < 1) return false;
  try {
    const hash = await derive(password, fromB64(parts[2]), iterations);
    return timingSafeEqual(hash, fromB64(parts[3]));
  } catch {
    return false;
  }
}
