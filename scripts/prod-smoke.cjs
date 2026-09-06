// 线上冒烟测试：登录 → 保存 → 列表 → SSO，全链路验证生产环境
const BASE = 'https://link-saver.junwind.site';
const EMAIL = 'redacted@example.com';
const CODE = process.argv[2];

async function req(method, path, { body, token } = {}) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(BASE + path, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(30000) });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

let failed = 0;
function check(name, cond, detail = '') {
  if (cond) console.log(`PASS  ${name}`);
  else { failed++; console.log(`FAIL  ${name}  ${detail}`); }
}

(async () => {
  const login = await req('POST', '/api/auth/verify', { body: { email: EMAIL, code: CODE } });
  check('验证码登录', login.status === 200 && login.data.token, JSON.stringify(login.data));
  if (!login.data.token) { console.log('无法继续'); process.exit(1); }
  const token = login.data.token;

  const me = await req('GET', '/api/auth/me', { token });
  check('当前用户', me.status === 200 && me.data.email === EMAIL, JSON.stringify(me.data));

  const site = await req('POST', '/api/links', { token, body: { url: 'https://github.com/', title: 'GitHub' } });
  check('保存网站 → 分类 github.com', site.status === 200 && site.data.type === 'site' && site.data.category === 'github.com', JSON.stringify(site.data));

  const art = await req('POST', '/api/links', { token, body: { url: 'https://developers.cloudflare.com/d1/learn/database-faqs/', title: '' } });
  check('保存文章 → 文章分类 + 兜底标题（异步补全）', art.status === 200 && art.data.type === 'article' && art.data.category === 'articles' && art.data.title.length > 0, JSON.stringify(art.data));

  const list = await req('GET', '/api/links?type=all', { token });
  check('列表可读', list.status === 200 && list.data.total >= 2, `total=${list.data.total}`);

  const ov = await req('GET', '/api/links/overview', { token });
  check('分类归档', ov.status === 200 && ov.data.categories.some((c) => c.name === 'github.com') && ov.data.months.length >= 1, JSON.stringify(ov.data));

  const ott = await req('POST', '/api/sso/ott', { token });
  const ex = await req('POST', '/api/sso/exchange', { body: { ott: ott.data.ott } });
  check('扩展 SSO 换取凭证', ex.status === 200 && ex.data.token && ex.data.email === EMAIL, JSON.stringify(ex.data).slice(0, 120));

  console.log(failed ? `\n${failed} 项失败` : '\n生产环境全链路验证通过');
  process.exit(failed ? 1 : 0);
})();
