// 本地端到端测试：签发测试 JWT 后依次调用核心接口
const BASE = process.env.E2E_BASE || 'http://127.0.0.1:8787';
const SECRET = 'local-e2e-secret';

function b64url(input) {
  return Buffer.from(input).toString('base64url');
}

function signJwt(payload) {
  const head = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = b64url(JSON.stringify(payload));
  const sig = require('crypto').createHmac('sha256', SECRET).update(`${head}.${body}`).digest('base64url');
  return `${head}.${body}.${sig}`;
}

let failed = 0;
function check(name, cond, detail = '') {
  if (cond) console.log(`PASS  ${name}`);
  else { failed++; console.log(`FAIL  ${name}  ${detail}`); }
}

async function req(method, path, { body, token } = {}) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(BASE + path, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  let data = {};
  try { data = await res.json(); } catch {}
  return { status: res.status, data };
}

(async () => {
  // 未登录应被拒绝
  const anon = await req('GET', '/api/links');
  check('未登录访问列表返回 401', anon.status === 401, JSON.stringify(anon));

  const token = signJwt({ sub: '1', email: 'tester@junwind.site', iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600 });

  const me = await req('GET', '/api/auth/me', { token });
  check('GET /auth/me', me.status === 200 && me.data.email === 'tester@junwind.site', JSON.stringify(me));

  // 保存纯域名 → 网站，分类=域名
  const site = await req('POST', '/api/links', { token, body: { url: 'https://github.com/', title: 'GitHub' } });
  check('保存域名 → site / 分类 github.com', site.status === 200 && site.data.type === 'site' && site.data.category === 'github.com', JSON.stringify(site));

  // 保存文章页 → article，并自动补站点记录
  const art = await req('POST', '/api/links', { token, body: { url: 'https://github.com/topics/workers?page=2', title: '' } });
  check('保存文章页 → article / 分类 articles', art.status === 200 && art.data.type === 'article' && art.data.category === 'articles', JSON.stringify(art));

  // 重复保存 → existed
  const dup = await req('POST', '/api/links', { token, body: { url: 'https://github.com/', title: 'GitHub' } });
  check('重复保存标记 existed', dup.status === 200 && dup.data.existed === true, JSON.stringify(dup));

  // 非法协议 / 内网地址应拒绝
  const bad1 = await req('POST', '/api/links', { token, body: { url: 'ftp://example.com/x' } });
  const bad2 = await req('POST', '/api/links', { token, body: { url: 'http://127.0.0.1:8080/admin' } });
  const bad3 = await req('POST', '/api/links', { token, body: { url: 'http://192.168.1.10/x' } });
  check('拒绝非 http/https', bad1.status === 400, JSON.stringify(bad1));
  check('拒绝环回地址', bad2.status === 400, JSON.stringify(bad2));
  check('拒绝内网地址', bad3.status === 400, JSON.stringify(bad3));

  // 列表与筛选
  const list = await req('GET', '/api/links?type=site', { token });
  check('网站列表包含 github.com', list.status === 200 && list.data.items.some((i) => i.category === 'github.com'), JSON.stringify(list.data).slice(0, 300));
  const articles = await req('GET', '/api/links?type=article', { token });
  check('文章列表包含已存文章', articles.status === 200 && articles.data.items.length >= 1, JSON.stringify(articles.data).slice(0, 300));

  // overview：分类与归档
  const ov = await req('GET', '/api/links/overview', { token });
  check('overview 含分类与月份归档', ov.status === 200 && ov.data.categories.some((c) => c.name === 'github.com') && ov.data.months.length >= 1, JSON.stringify(ov.data));

  // SSO：签发一次性令牌并交换
  const ott = await req('POST', '/api/sso/ott', { token });
  check('签发 OTT', ott.status === 200 && /^[0-9a-f]{32}$/.test(ott.data.ott || ''), JSON.stringify(ott));
  const ex = await req('POST', '/api/sso/exchange', { body: { ott: ott.data.ott } });
  check('OTT 交换正式凭证', ex.status === 200 && ex.data.token && ex.data.email === 'tester@junwind.site', JSON.stringify(ex).slice(0, 200));
  const ex2 = await req('POST', '/api/sso/exchange', { body: { ott: ott.data.ott } });
  check('OTT 一次性（第二次失效）', ex2.status === 401, JSON.stringify(ex2));

  // offset 越过结果集末尾时 total 仍应正确
  const beyond = await req('GET', '/api/links?offset=99999', { token });
  check('offset 越界 total 仍正确', beyond.status === 200 && beyond.data.total > 0 && beyond.data.items.length === 0, JSON.stringify(beyond.data));

  // LIKE 通配符按字面处理：q='%' 不应匹配任何记录
  const wildcard = await req('GET', `/api/links?q=${encodeURIComponent('%')}`, { token });
  check('LIKE 通配符按字面处理', wildcard.status === 200 && wildcard.data.total === 0, JSON.stringify(wildcard.data));

  // 文章 URL 归一化：锚点与 utm 被剥离，业务参数保留
  const tracked = await req('POST', '/api/links', {
    token,
    body: { url: 'https://example.org/post?utm_source=t&utm_medium=x&id=7#top', title: '示例文章' },
  });
  const found = await req('GET', `/api/links?q=${encodeURIComponent('example.org')}`, { token });
  const hit = (found.data.items || []).find((i) => i.url.startsWith('https://example.org/post'));
  check('追踪参数与锚点被剥离', tracked.status === 200 && hit && hit.url === 'https://example.org/post?id=7', JSON.stringify(hit));

  // 删除
  const firstId = articles.data.items?.[0]?.id;
  if (!firstId) { console.log('FAIL  删除文章（无文章可删）'); failed++; }
  else {
    const del = await req('DELETE', `/api/links/${firstId}`, { token });
    check('删除文章', del.status === 200, JSON.stringify(del));
  }

  // ---- 注册 / 密码登录 / 找回密码 ----
  // 本地 .dev.vars 为假 Resend 密钥，发信返回 502，但验证码已写入 KV，可从本地 KV 读取
  const { execSync } = require('child_process');
  const path = require('path');
  // 本地 miniflare 异步刷盘，读码需轮询等待键可见
  const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  const readLocalCode = (purpose, email, tries = 12) => {
    const key = `code:${purpose}:${email}`;
    let lastErr = '';
    for (let i = 0; i < tries; i++) {
      try {
        const raw = execSync(`npx wrangler kv key get "${key}" --binding KV --local`, {
          cwd: path.join(__dirname, '..', 'worker'),
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
        });
        return JSON.parse(raw.replace(/\x1b\[[0-9;]*m/g, '').trim().split('\n').pop()).code;
      } catch (e) {
        lastErr = String(e.stderr || e.message).slice(0, 100);
        sleepSync(800);
      }
    }
    throw new Error(`未能读取本地验证码 ${key}: ${lastErr}`);
  };

  const regEmail = `e2e-reg-${Date.now()}@test.local`;
  const pw1 = 'e2epass123';
  const pw2 = 'e2enew456';

  const regReq = await req('POST', '/api/auth/register/request-code', { body: { email: regEmail } });
  console.log('  [register/request-code]', regReq.status, JSON.stringify(regReq.data));
  const regCode = readLocalCode('register', regEmail);
  const reg = await req('POST', '/api/auth/register', { body: { email: regEmail, password: pw1, code: regCode } });
  check('注册成功并返回凭证', reg.status === 200 && reg.data.token, JSON.stringify(reg.data));

  const dupReg = await req('POST', '/api/auth/register/request-code', { body: { email: regEmail } });
  check('重复注册邮箱被拒(409)', dupReg.status === 409, JSON.stringify(dupReg.data));

  const weak = await req('POST', '/api/auth/register', { body: { email: regEmail, password: 'short', code: '000000' } });
  check('弱密码被拒', weak.status === 400 && /密码/.test(weak.data.error), JSON.stringify(weak.data));

  const wrongPw = await req('POST', '/api/auth/login', { body: { email: regEmail, password: 'wrongpass1' } });
  check('错误密码返回 401', wrongPw.status === 401, JSON.stringify(wrongPw.data));

  const noPw = await req('POST', '/api/auth/login', { body: { email: 'tester@junwind.site', password: 'whatever1' } });
  check('未设密码账号给出引导提示', noPw.status === 401 && /未设置密码/.test(noPw.data.error), JSON.stringify(noPw.data));

  const okLogin = await req('POST', '/api/auth/login', { body: { email: regEmail, password: pw1 } });
  check('密码登录成功', okLogin.status === 200 && okLogin.data.token, JSON.stringify(okLogin.data));

  await req('POST', '/api/auth/reset/request-code', { body: { email: regEmail } });
  const resetCode = readLocalCode('reset', regEmail);
  const reset = await req('POST', '/api/auth/reset-password', { body: { email: regEmail, code: resetCode, new_password: pw2 } });
  check('重置密码成功', reset.status === 200 && reset.data.token, JSON.stringify(reset.data));

  const oldPw = await req('POST', '/api/auth/login', { body: { email: regEmail, password: pw1 } });
  check('旧密码已失效', oldPw.status === 401, JSON.stringify(oldPw.data));
  const newPw = await req('POST', '/api/auth/login', { body: { email: regEmail, password: pw2 } });
  check('新密码可登录', newPw.status === 200 && newPw.data.token, JSON.stringify(newPw.data));

  const ghost = await req('POST', '/api/auth/reset/request-code', { body: { email: `e2e-ghost-${Date.now()}@test.local` } });
  check('重置请求防枚举（未注册也返回 ok）', ghost.status === 200 && ghost.data.ok === true, JSON.stringify(ghost.data));

  console.log(failed ? `\n${failed} 项失败` : '\n全部通过');
  process.exit(failed ? 1 : 0);
})();
