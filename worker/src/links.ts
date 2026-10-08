import { Hono } from 'hono';
import type { Env } from './types';
import { ARTICLE_CATEGORY } from './types';
import { requireAuth } from './middleware';
import { assertPublicHttpUrl, classifyUrl, fallbackTitle, fetchPageTitle } from './url';
import { autoTag } from './classify';

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
  // 网页端「网站 / 文章」页签可显式指定类型，覆盖自动归类；扩展保存不传，仍走自动归类
  const forcedType = body.type === 'site' || body.type === 'article' ? body.type : '';
  const type = forcedType || cls.type;
  const category = type === 'article' ? ARTICLE_CATEGORY : cls.domain;
  const providedTitle = typeof body.title === 'string' ? body.title.replace(/\s+/g, ' ').trim().slice(0, 300) : '';
  // 备注：用户自行标识（如「待读」「参考」），不传时保留已备注
  const providedNote = typeof body.note === 'string' ? body.note.replace(/\s+/g, ' ').trim().slice(0, 200) : '';
  // 属性标签：规则分类（域名 + 标题关键词），手动指定优先；扩展保存不传则自动识别
  const tag = (typeof body.tag === 'string' ? body.tag.replace(/\s+/g, ' ').trim().slice(0, 30) : '')
    || autoTag(u.hostname, providedTitle, cls.canonical);

  const existing = await c.env.DB.prepare('SELECT id, title FROM links WHERE user_id = ? AND url = ?')
    .bind(userId, cls.canonical)
    .first<{ id: number; title: string }>();

  // 未提供标题时不降级已存标题；新文章先用兜底标题入库，保存响应后异步抓取 <title> 回填
  let title = providedTitle;
  let backfill = false;
  if (!title) {
    title = existing
      ? existing.title || fallbackTitle(u)
      : type === 'site'
        ? cls.domain
        : fallbackTitle(u);
    backfill = type === 'article';
  }

  const upsert = c.env.DB.prepare(
    `INSERT INTO links (user_id, url, title, domain, type, category, note, tag) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_id, url) DO UPDATE SET
       title = CASE WHEN excluded.title <> '' THEN excluded.title ELSE title END,
       note = CASE WHEN excluded.note <> '' THEN excluded.note ELSE note END,
       type = excluded.type,
       category = excluded.category,
       tag = CASE WHEN tag = '' THEN excluded.tag ELSE tag END,
       created_at = datetime('now')`,
  ).bind(userId, cls.canonical, title, cls.domain, type, category, providedNote, tag);

  if (type === 'article') {
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
    type,
    category,
    domain: cls.domain,
    title: title || existing?.title || '',
    tag,
    existed: Boolean(existing),
  });
});

// 「一键识别」：对尚未打标签的链接跑规则分类，手动改过的标签不被覆盖
linkRoutes.post('/auto-tag', async (c) => {
  const userId = c.get('userId');
  const force = Boolean((await c.req.json().catch(() => ({})) as { force?: boolean }).force);
  const rows = await c.env.DB.prepare(
    `SELECT id, url, domain, title, tag FROM links WHERE user_id = ?${force ? '' : " AND tag = ''"}`,
  )
    .bind(userId)
    .all<{ id: number; url: string; domain: string; title: string; tag: string }>();

  const byTag: Record<string, number> = {};
  let skipped = 0;
  const stmts = [];
  for (const row of rows.results ?? []) {
    const tag = autoTag(row.domain, row.title, row.url);
    if (!tag) {
      skipped += 1;
      continue;
    }
    byTag[tag] = (byTag[tag] ?? 0) + 1;
    stmts.push(
      c.env.DB.prepare('UPDATE links SET tag = ? WHERE id = ? AND user_id = ?').bind(tag, row.id, userId),
    );
  }
  // D1 batch 分批提交，避免语句过多超限
  for (let i = 0; i < stmts.length; i += 50) {
    await c.env.DB.batch(stmts.slice(i, i + 50));
  }

  return c.json({ ok: true, tagged: stmts.length, skipped, byTag });
});

linkRoutes.get('/', async (c) => {
  const userId = c.get('userId');
  const type = c.req.query('type') || 'all';
  const category = c.req.query('category')?.trim() || '';
  const month = c.req.query('month')?.trim() || '';
  const days = Math.min(Math.max(Number(c.req.query('days')) || 0, 0), 3650);
  const q = c.req.query('q')?.trim() || '';
  const note = c.req.query('note')?.trim() || '';
  const tag = c.req.query('tag')?.trim() || '';
  const limit = Math.min(Math.max(Number(c.req.query('limit')) || 50, 1), 100);
  const offset = Math.max(Number(c.req.query('offset')) || 0, 0);

  const where: string[] = ['user_id = ?'];
  const binds: unknown[] = [userId];
  if (type === 'site' || type === 'article') {
    where.push('type = ?');
    binds.push(type);
  }
  if (note) {
    where.push('note = ?');
    binds.push(note);
  }
  if (tag) {
    where.push('tag = ?');
    binds.push(tag);
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
    // 转义 LIKE 通配符，让 %/_ 按字面匹配；备注也参与搜索
    const like = `%${q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
    where.push(`(title LIKE ? ESCAPE '\\' OR url LIKE ? ESCAPE '\\' OR note LIKE ? ESCAPE '\\')`);
    binds.push(like, like, like);
  }

  const whereSql = where.join(' AND ');
  const [countRow, rows] = await Promise.all([
    c.env.DB.prepare(`SELECT COUNT(*) AS total FROM links WHERE ${whereSql}`)
      .bind(...binds)
      .first<{ total: number }>(),
    c.env.DB.prepare(
      `SELECT id, url, title, domain, type, category, note, tag, created_at
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
        note: string;
        tag: string;
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
  const [typeCounts, categories, months, snippetCounts, textMonths, imageMonths, noteRows, tagRows, untaggedRow] = await Promise.all([
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
    // 备注去重列表：链接与片段来源合并计数，同一备注只出现一次
    c.env.DB.prepare(
      `SELECT note AS name, SUM(cnt) AS count FROM (
         SELECT note, COUNT(*) AS cnt FROM links WHERE user_id = ? AND note <> '' GROUP BY note
         UNION ALL
         SELECT note, COUNT(*) AS cnt FROM snippets WHERE user_id = ? AND note <> '' GROUP BY note
       ) GROUP BY note ORDER BY count DESC, note ASC LIMIT 200`,
    )
      .bind(userId, userId)
      .all<{ name: string; count: number }>(),
    // 属性标签去重列表：按数量排序
    c.env.DB.prepare(
      `SELECT tag AS name, COUNT(*) AS count FROM links WHERE user_id = ? AND tag <> ''
       GROUP BY tag ORDER BY count DESC, name ASC LIMIT 200`,
    )
      .bind(userId)
      .all<{ name: string; count: number }>(),
    // 尚未识别的链接数（侧栏「一键识别」按钮上用）
    c.env.DB.prepare(`SELECT COUNT(*) AS count FROM links WHERE user_id = ? AND tag = ''`)
      .bind(userId)
      .first<{ count: number }>(),
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
    notes: noteRows.results ?? [],
    tags: tagRows.results ?? [],
    untagged: untaggedRow?.count ?? 0,
  });
});

// 网页端编辑备注 / 属性标签（留空即清除），两者至少传一个
linkRoutes.patch('/:id', async (c) => {
  const id = Number(c.req.param('id'));
  if (!Number.isInteger(id) || id <= 0) return c.json({ error: '参数不正确' }, 400);
  const body = await c.req.json().catch(() => ({}));
  const hasNote = typeof body.note === 'string';
  const hasTag = typeof body.tag === 'string';
  if (!hasNote && !hasTag) return c.json({ error: '缺少 note 或 tag 参数' }, 400);
  const noteVal = hasNote ? body.note.replace(/\s+/g, ' ').trim().slice(0, 200) : '';
  const tagVal = hasTag ? body.tag.replace(/\s+/g, ' ').trim().slice(0, 30) : '';
  const fields: string[] = [];
  const binds: unknown[] = [];
  if (hasNote) {
    fields.push('note = ?');
    binds.push(noteVal);
  }
  if (hasTag) {
    fields.push('tag = ?');
    binds.push(tagVal);
  }
  const result = await c.env.DB.prepare(`UPDATE links SET ${fields.join(', ')} WHERE id = ? AND user_id = ?`)
    .bind(...binds, id, c.get('userId'))
    .run();
  if (!result.meta.changes) return c.json({ error: '记录不存在' }, 404);
  return c.json({ ok: true, note: hasNote ? noteVal : undefined, tag: hasTag ? tagVal : undefined });
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
