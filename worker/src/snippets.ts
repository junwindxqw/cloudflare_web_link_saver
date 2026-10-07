import { Hono } from 'hono';
import type { Env } from './types';
import { requireAuth } from './middleware';
import { assertPublicHttpUrl } from './url';

const MAX_TEXT_CHARS = 10_000;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_SOURCE_LEN = 2000;
// 带浏览器 UA 与来源页 Referer 抓图：大量论坛/图床按这两项做防盗链
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

type StoredImage = { key: string; mime: string; bytes: number };

export const snippetRoutes = new Hono<{ Bindings: Env; Variables: { userId: number; email: string } }>();
snippetRoutes.use('*', requireAuth);

snippetRoutes.post('/', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const type = body?.type === 'text' || body?.type === 'image' ? body.type : '';
  if (!type) return c.json({ error: 'type 必须为 text 或 image' }, 400);

  const content = typeof body?.content === 'string' ? body.content.trim() : '';
  if (!content) return c.json({ error: '内容不能为空' }, 400);

  // 来源信息仅作展示用：只接受公网 http/https 链接，长度截断
  let sourceUrl = typeof body?.source_url === 'string' ? body.source_url.trim() : '';
  if (sourceUrl) {
    try {
      sourceUrl = assertPublicHttpUrl(sourceUrl).toString();
    } catch {
      sourceUrl = '';
    }
  }
  const sourceTitle = (typeof body?.source_title === 'string' ? body.source_title : '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 300);

  const userId = c.get('userId');

  if (type === 'text') {
    const res = await c.env.DB.prepare(
      'INSERT INTO snippets (user_id, type, content, source_url, source_title) VALUES (?, ?, ?, ?, ?)',
    )
      .bind(userId, 'text', content.slice(0, MAX_TEXT_CHARS), sourceUrl, sourceTitle)
      .run();
    return c.json({ ok: true, id: res.meta.last_row_id, stored: true });
  }

  // 图片：服务端转存到 R2 对象存储（按内容哈希去重），失败时回退保存原始链接
  let stored: StoredImage | null = null;
  let saveError = '';
  const isDataUrl = content.startsWith('data:');
  if (isDataUrl) {
    const parsed = parseDataUrlImage(content);
    if (typeof parsed === 'string') saveError = parsed;
    else stored = await saveMedia(c.env, parsed.buf, parsed.mime);
  } else if (/^https?:\/\//i.test(content)) {
    stored = await storeRemoteImage(c.env, content, sourceUrl);
  } else {
    saveError = '仅支持 http/https 图片地址';
  }
  if (saveError) return c.json({ error: saveError }, 400);

  const res = await c.env.DB.prepare(
    `INSERT INTO snippets (user_id, type, content, storage_key, mime, bytes, source_url, source_title)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    // data: URL 可能非常大不落库；远程地址保留原始外链，KV 未命中时可回退
    .bind(userId, 'image', isDataUrl ? '' : content, stored?.key ?? '', stored?.mime ?? '', stored?.bytes ?? 0, sourceUrl, sourceTitle)
    .run();

  return c.json({ ok: true, id: res.meta.last_row_id, stored: Boolean(stored), mime: stored?.mime ?? '', bytes: stored?.bytes ?? 0 });
});

snippetRoutes.get('/', async (c) => {
  const userId = c.get('userId');
  const rawType = c.req.query('type') || '';
  const type = rawType === 'text' || rawType === 'image' ? rawType : '';
  const q = c.req.query('q')?.trim() || '';
  const month = c.req.query('month')?.trim() || '';
  const days = Math.min(Math.max(Number(c.req.query('days')) || 0, 0), 3650);
  const limit = Math.min(Math.max(Number(c.req.query('limit')) || 50, 1), 100);
  const offset = Math.max(Number(c.req.query('offset')) || 0, 0);

  const where: string[] = ['user_id = ?'];
  const binds: unknown[] = [userId];
  if (type) {
    where.push('type = ?');
    binds.push(type);
  }
  if (month) {
    where.push("strftime('%Y-%m', created_at) = ?");
    binds.push(month);
  }
  if (days > 0) {
    where.push("created_at >= datetime('now', ?)");
    binds.push(`-${days} days`);
  }
  if (q) {
    // 与链接列表一致：转义 LIKE 通配符，按字面匹配
    const like = `%${q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
    where.push(`(content LIKE ? ESCAPE '\\' OR source_title LIKE ? ESCAPE '\\' OR source_url LIKE ? ESCAPE '\\')`);
    binds.push(like, like, like);
  }

  const whereSql = where.join(' AND ');
  const [countRow, rows] = await Promise.all([
    c.env.DB.prepare(`SELECT COUNT(*) AS total FROM snippets WHERE ${whereSql}`)
      .bind(...binds)
      .first<{ total: number }>(),
    c.env.DB.prepare(
      `SELECT id, type, content, storage_key, mime, bytes, source_url, source_title, created_at
       FROM snippets WHERE ${whereSql}
       ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`,
    )
      .bind(...binds, limit, offset)
      .all<{
        id: number;
        type: 'text' | 'image';
        content: string;
        storage_key: string;
        mime: string;
        bytes: number;
        source_url: string;
        source_title: string;
        created_at: string;
      }>(),
  ]);

  return c.json({ ok: true, items: rows.results ?? [], total: countRow?.total ?? 0, limit, offset });
});

// 已转存图片的读取入口：仅本人可读；存储未命中时回退到原始外链
snippetRoutes.get('/:id/image', async (c) => {
  const id = Number(c.req.param('id'));
  if (!Number.isInteger(id) || id <= 0) return c.json({ error: '参数不正确' }, 400);

  const row = await c.env.DB.prepare('SELECT storage_key, mime, content FROM snippets WHERE id = ? AND user_id = ?')
    .bind(id, c.get('userId'))
    .first<{ storage_key: string; mime: string; content: string }>();
  if (!row) return c.json({ error: '记录不存在' }, 404);

  if (row.storage_key) {
    const buf = await loadMedia(c.env, row.storage_key);
    if (buf) {
      return new Response(buf, {
        headers: {
          'Content-Type': row.mime || 'application/octet-stream',
          'Cache-Control': 'private, max-age=86400',
          'X-Content-Type-Options': 'nosniff',
        },
      });
    }
  }
  if (/^https?:\/\//i.test(row.content)) return c.redirect(row.content, 302);
  return c.json({ error: '图片不可用' }, 404);
});

snippetRoutes.delete('/:id', async (c) => {
  const id = Number(c.req.param('id'));
  if (!Number.isInteger(id) || id <= 0) return c.json({ error: '参数不正确' }, 400);

  const userId = c.get('userId');
  const row = await c.env.DB.prepare('SELECT storage_key FROM snippets WHERE id = ? AND user_id = ?')
    .bind(id, userId)
    .first<{ storage_key: string }>();
  if (!row) return c.json({ error: '记录不存在' }, 404);

  await c.env.DB.prepare('DELETE FROM snippets WHERE id = ? AND user_id = ?').bind(id, userId).run();

  // 转存图片按内容哈希去重共享：仅当无任何记录引用时才清理存储
  if (row.storage_key) {
    c.executionCtx.waitUntil(
      (async () => {
        const ref = await c.env.DB.prepare('SELECT COUNT(*) AS n FROM snippets WHERE storage_key = ?')
          .bind(row.storage_key)
          .first<{ n: number }>();
        if ((ref?.n ?? 0) === 0) await deleteMedia(c.env, row.storage_key);
      })().catch((e) => console.error('snippet image cleanup failed', e)),
    );
  }

  return c.json({ ok: true });
});

/* ---------------- 图片转存 ---------------- */

function parseDataUrlImage(raw: string): { buf: ArrayBuffer; mime: string } | string {
  const m = raw.match(/^data:(image\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=\s]+)$/);
  if (!m) return '仅支持 base64 编码的 data:image/* 地址';
  const mime = m[1].toLowerCase();
  const b64 = m[2].replace(/\s+/g, '');
  let bin: string;
  try {
    bin = atob(b64);
  } catch {
    return '图片 base64 解码失败';
  }
  if (bin.length > MAX_IMAGE_BYTES) return '图片过大（上限 5MB）';
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return { buf: bytes.buffer, mime };
}

/**
 * 抓取远程图片并转存。手动跟随重定向，每一跳都重新校验目标地址（与抓取标题同样的 SSRF 约束），
 * 携带来源页 Referer 与浏览器 UA 以通过常见防盗链；内容类型必须是 image/*，体积超限即放弃。
 * 任何一步失败返回 null（调用方回退为保存外链）。
 */
async function storeRemoteImage(env: Env, rawUrl: string, referer: string): Promise<StoredImage | null> {
  let current = rawUrl;
  for (let hop = 0; hop < 3; hop++) {
    let u: URL;
    try {
      u = assertPublicHttpUrl(current);
    } catch {
      return null;
    }
    const headers: Record<string, string> = { 'user-agent': USER_AGENT, accept: 'image/avif,image/webp,image/*,*/*;q=0.8' };
    if (referer) headers.referer = referer;
    let res: Response;
    try {
      res = await fetch(u, {
        redirect: 'manual',
        signal: AbortSignal.timeout(10000),
        headers,
      });
    } catch {
      return null;
    }
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location');
      if (!loc) return null;
      try {
        current = new URL(loc, u).toString();
      } catch {
        return null;
      }
      continue;
    }
    if (!res.ok) return null;
    const mime = (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    if (!mime.startsWith('image/')) return null;
    const buf = await readCapped(res, MAX_IMAGE_BYTES);
    if (!buf) return null;
    return saveMedia(env, buf, mime);
  }
  return null;
}

/** 流式读取响应体，超过 cap 字节视为失败，避免大文件撑爆内存 */
async function readCapped(res: Response, cap: number): Promise<ArrayBuffer | null> {
  const reader = res.body?.getReader();
  if (!reader) return null;
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > cap) return null;
      chunks.push(value);
    }
  } catch {
    return null;
  } finally {
    await reader.cancel().catch(() => {});
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const ch of chunks) {
    out.set(ch, off);
    off += ch.byteLength;
  }
  return out.buffer;
}

/** 按内容 SHA-256 作为对象键写入（优先 R2，回退 KV），同一张图重复保存不占额外空间 */
async function saveMedia(env: Env, buf: ArrayBuffer, mime: string): Promise<StoredImage> {
  const digest = await crypto.subtle.digest('SHA-256', buf);
  const key = `img:${[...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
  if (env.MEDIA) await env.MEDIA.put(key, buf);
  else await env.KV.put(key, buf, { metadata: { contentType: mime } });
  return { key, mime, bytes: buf.byteLength };
}

/** 读取转存对象：优先 R2，未命中时回退 KV（兼容历史数据） */
async function loadMedia(env: Env, key: string): Promise<ArrayBuffer | null> {
  if (env.MEDIA) {
    const obj = await env.MEDIA.get(key);
    if (obj) return obj.arrayBuffer();
  }
  return env.KV.get(key, { type: 'arrayBuffer' });
}

/** 清理转存对象：R2 与 KV 都尝试，避免历史数据残留 */
async function deleteMedia(env: Env, key: string): Promise<void> {
  try {
    if (env.MEDIA) await env.MEDIA.delete(key);
  } catch (e) {
    console.error('r2 delete failed', e);
  }
  try {
    await env.KV.delete(key);
  } catch (e) {
    console.error('kv delete failed', e);
  }
}
