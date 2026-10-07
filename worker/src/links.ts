import { Hono } from 'hono';
import type { Env } from './types';
import { requireAuth } from './middleware';
import { assertPublicHttpUrl, classifyUrl, fallbackTitle, fetchPageTitle } from './url';

export const linkRoutes = new Hono<{ Bindings: Env; Variables: { userId: number; email: string } }>();
linkRoutes.use('*', requireAuth);

linkRoutes.post('/', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const rawUrl = typeof body.url === 'string' ? body.url.trim() : '';
  if (!rawUrl) return c.json({ error: '缺少 url 参数' }, 400);

  let u;
  try {
    u = assertPublicHttpUrl(rawUrl);
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : 'URL 不合法' }, 400);
  }

  const userId = c.get('userId');
  const cls = classifyUrl(u);
  const providedTitle = typeof body.title === 'string' ? body.title.replace(/\s+/g, ' ').trim().slice(0, 300) : '';

  const existing = await c.env.DB.prepare('SELECT id, title FROM links WHERE user_id = ? AND url = ?')
    .bind(userId, cls.canonical)
    .first<{ id: number; title: string }>();

  // 未提供标题时不降级已存标题；新文章先用兜底标题入库，保存响应后异步抓取 <title> 补全
  let title = providedTitle;
  let backfill = false;
  if (!title) {
    title = existing
      ? existing.title || fallbackTitle(u)
      : cls.type === 'site'
        ? cls.domain
        : fallbackTitle(u);
    backfill = cls.type === 'article';
  }

  const upsert = c.env.DB.prepare(
    `INSERT INTO links (user_id, url, title, domain, type, category) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_id, url) DO UPDATE SET
       title = CASE WHEN excluded.title <> '' THEN excluded.title ELSE title END,
       created_at = datetime('now')`,
  ).bind(userId, cls.canonical, title, cls.domain, cls.type, cls.category);

  if (cls.type === 'article') {
    // 文章页同时归档所属站点域名：若该域名尚未保存为网站则自动补一条
    const siteUpsert = c.env.DB.prepare(
      `INSERT OR IGNORE INTO links (user_id, url, title, domain, type, category) VALUES (?, ?, ?, ?, 'site', ?)`,
    ).bind(userId, u.origin + '/', cls.domain, cls.domain, cls.domain);
    await c.env.DB.batch([upsert, siteUpsert]);
  } else {
    await upsert.run();
  }

  if (backfill) {
    const row = await c.env.DB.prepare('SELECT id, title FROM links WHERE user_id = ? AND url = ?')
      .bind(userId, cls.canonical)
      .first<{ id: number; title: string }>();
    if (row) {
      // waitUntil：响应返回后继续抓取标题，仅当该行标题未被用户改动时回填
      c.executionCtx.waitUntil(
        (async () => {
          const fetched = await fetchPageTitle(cls.canonical);
          if (!fetched || fetched === row.title) return;
          await c.env.DB.prepare('UPDATE links SET title = ? WHERE id = ? AND title = ?')
            .bind(fetched, row.id, row.title)
            .run();
        })().catch((e) => console.error('title backfill failed', e)),
      );
    }
  }

  return c.json({
    ok: true,
    type: cls.type,
    category: cls.category,
    domain: cls.domain,
    title: title || existing?.title || '',
    existed: Boolean(existing),
  });
});

linkRoutes.get('/', async (c) => {
  const userId = c.get('userId');
  const type = c.req.query('type') || 'all';
  const category = c.req.query('category')?.trim() || '';
  const month = c.req.query('month')?.trim() || '';
  const days = Math.min(Math.max(Number(c.req.query('days')) || 0, 0), 3650);
  const q = c.req.query('q')?.trim() || '';
  const limit = Math.min(Math.max(Number(c.req.query('limit')) || 50, 1), 100);
  const offset = Math.max(Number(c.req.query('offset')) || 0, 0);

  const where: string[] = ['user_id = ?'];
  const binds: unknown[] = [userId];
  if (type === 'site' || type === 'article') {
    where.push('type = ?');
    binds.push(type);
  }
  if (category) {
    where.push('category = ?');
    binds.push(category);
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
    // 转义 LIKE 通配符，让 %/_ 按字面匹配
    const like = `%${q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
    where.push(`(title LIKE ? ESCAPE '\\' OR url LIKE ? ESCAPE '\\')`);
    binds.push(like, like);
  }

  const whereSql = where.join(' AND ');
  const [countRow, rows] = await Promise.all([
    c.env.DB.prepare(`SELECT COUNT(*) AS total FROM links WHERE ${whereSql}`)
      .bind(...binds)
      .first<{ total: number }>(),
    c.env.DB.prepare(
      `SELECT id, url, title, domain, type, category, created_at
       FROM links WHERE ${whereSql}
       ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`,
    )
      .bind(...binds, limit, offset)
      .all<{
        id: number;
        url: string;
        title: string;
        domain: string;
        type: 'site' | 'article';
        category: string;
        created_at: string;
      }>(),
  ]);

  return c.json({
    ok: true,
    items: rows.results ?? [],
    total: countRow?.total ?? 0,
    limit,
    offset,
  });
});

linkRoutes.get('/overview', async (c) => {
  const userId = c.get('userId');
  const [typeCounts, categories, months, snippetCounts, textMonths, imageMonths] = await Promise.all([
    c.env.DB.prepare(`SELECT type, COUNT(*) AS count FROM links WHERE user_id = ? GROUP BY type`).bind(userId).all<{
      type: 'site' | 'article';
      count: number;
    }>(),
    c.env.DB.prepare(
      `SELECT category AS name, COUNT(*) AS count FROM links WHERE user_id = ? AND type = 'site'
       GROUP BY category ORDER BY count DESC, name ASC LIMIT 200`,
    )
      .bind(userId)
      .all<{ name: string; count: number }>(),
    c.env.DB.prepare(
      `SELECT strftime('%Y-%m', created_at) AS month, COUNT(*) AS count FROM links WHERE user_id = ? AND type = 'article'
       GROUP BY month ORDER BY month DESC LIMIT 120`,
    )
      .bind(userId)
      .all<{ month: string; count: number }>(),
    c.env.DB.prepare(`SELECT type, COUNT(*) AS count FROM snippets WHERE user_id = ? GROUP BY type`).bind(userId).all<{
      type: 'text' | 'image';
      count: number;
    }>(),
    c.env.DB.prepare(
      `SELECT strftime('%Y-%m', created_at) AS month, COUNT(*) AS count FROM snippets WHERE user_id = ? AND type = 'text'
       GROUP BY month ORDER BY month DESC LIMIT 120`,
    )
      .bind(userId)
      .all<{ month: string; count: number }>(),
    c.env.DB.prepare(
      `SELECT strftime('%Y-%m', created_at) AS month, COUNT(*) AS count FROM snippets WHERE user_id = ? AND type = 'image'
       GROUP BY month ORDER BY month DESC LIMIT 120`,
    )
      .bind(userId)
      .all<{ month: string; count: number }>(),
  ]);

  const counts = { site: 0, article: 0 };
  for (const row of typeCounts.results ?? []) counts[row.type] = row.count;
  const snips = { text: 0, image: 0 };
  for (const row of snippetCounts.results ?? []) snips[row.type] = row.count;
  return c.json({
    ok: true,
    typeCounts: counts,
    snippetCounts: snips,
    categories: categories.results ?? [],
    months: months.results ?? [],
    textMonths: textMonths.results ?? [],
    imageMonths: imageMonths.results ?? [],
  });
});

linkRoutes.delete('/:id', async (c) => {
  const id = Number(c.req.param('id'));
  if (!Number.isInteger(id) || id <= 0) return c.json({ error: '参数不正确' }, 400);
  const result = await c.env.DB.prepare('DELETE FROM links WHERE id = ? AND user_id = ?')
    .bind(id, c.get('userId'))
    .run();
  if (!result.meta.changes) return c.json({ error: '记录不存在' }, 404);
  return c.json({ ok: true });
});
