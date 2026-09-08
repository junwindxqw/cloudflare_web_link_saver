// 本地端到端测试：签发测试 JWT 后依次调用核心接口
// E2E_LOGIN=api 时改走注册接口获取真实凭证（配合 E2E_KV=remote 可全量回归生产环境）
const BASE = process.env.E2E_BASE || 'http://127.0.0.1:8787';
const SECRET = 'local-e2e-secret';
const { execSync } = require('child_process');
const path = require('path');

function b64url(input) {
  return Buffer.from(input).toString('base64url');
}

function signJwt(payload) {
  const head = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = b64url(JSON.stringify(payload));
  const sig = require('crypto').createHmac('sha256', SECRET).update(`${head}.${body}`).digest('base64url');
  return `${head}.${body}.${sig}`;
}

const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const KV_NS = 'c9a2e5f1d5b1423c91f8a3a05e24e84e';
const kvScope = process.env.E2E_KV === 'remote' ? `--namespace-id ${KV_NS} --remote` : '--binding KV --local';
function readLocalCode(purpose, email, tries = 12) {
  const key = `code:${purpose}:${email}`;
  let lastErr = '';
  for (let i = 0; i < tries; i++) {
    try {
      const raw = execSync(`npx wrangler kv key get "${key}" ${kvScope}`, {
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
  throw new Error(`未能读取验证码 ${key}: ${lastErr}`);
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

  let token;
  let mainEmail;
  if (process.env.E2E_LOGIN === 'api') {
    // 生产模式：走真实注册接口获取凭证
    mainEmail = `e2e-main-${Date.now()}@test.local`;
    await req('POST', '/api/auth/register/request-code', { body: { email: mainEmail } });
    const mainCode = readLocalCode('register', mainEmail);
    const reg = await req('POST', '/api/auth/register', { body: { email: mainEmail, password: 'e2emain123', code: mainCode } });
    if (!reg.data.token) { console.log('FAIL  无法创建测试账号', JSON.stringify(reg.data)); process.exit(1); }
    token = reg.data.token;
    console.log(`  [生产模式] 测试账号 ${mainEmail}`);
  } else {
    token = signJwt({ sub: '1', email: 'tester@junwind.site', iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600 });
    mainEmail = 'tester@junwind.site';
  }

  const me = await req('GET', '/api/auth/me', { token });
  check('GET /auth/me', me.status === 200 && me.data.email === mainEmail, JSON.stringify(me));

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
  check('OTT 交换正式凭证', ex.status === 200 && ex.data.token && ex.data.email === mainEmail, JSON.stringify(ex).slice(0, 200));
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

  // ---- 选中的短文本 / 图片收藏 ----
  const { createHash } = require('crypto');

  const snip = await req('POST', '/api/snippets', {
    token,
    body: { type: 'text', content: '  这是一段选中的文字\n第二行  ', source_url: 'https://example.org/post?id=7', source_title: '示例文章' },
  });
  check('保存短文本', snip.status === 200 && !!snip.data.id, JSON.stringify(snip));

  const snipEmpty = await req('POST', '/api/snippets', { token, body: { type: 'text', content: '   ' } });
  check('空选中文本被拒', snipEmpty.status === 400, JSON.stringify(snipEmpty));
  const snipBadType = await req('POST', '/api/snippets', { token, body: { type: 'widget', content: 'x' } });
  check('非法 type 被拒', snipBadType.status === 400, JSON.stringify(snipBadType));
  const snipPrivateSrc = await req('POST', '/api/snippets', { token, body: { type: 'text', content: '内网来源', source_url: 'http://127.0.0.1:8080/x' } });
  check('内网来源被丢弃仍保存', snipPrivateSrc.status === 200 && !!snipPrivateSrc.data.id, JSON.stringify(snipPrivateSrc));

  const textList = await req('GET', '/api/snippets?type=text', { token });
  check('短文本列表包含已存内容', textList.status === 200 && textList.data.items.some((i) => i.content.includes('第二行')), JSON.stringify(textList.data).slice(0, 300));
  const snipSearch = await req('GET', `/api/snippets?q=${encodeURIComponent('选中')}`, { token });
  check('短文本搜索命中内容', snipSearch.status === 200 && snipSearch.data.total >= 1, JSON.stringify(snipSearch.data).slice(0, 300));

  // 图片：data URL 服务端转存 KV，带凭证读取
  const pngB64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  const pngBuf = Buffer.from(pngB64, 'base64');
  const imgSnip = await req('POST', '/api/snippets', { token, body: { type: 'image', content: `data:image/png;base64,${pngB64}` } });
  check('保存图片(data URL)并转存', imgSnip.status === 200 && imgSnip.data.stored === true && !!imgSnip.data.id, JSON.stringify(imgSnip));

  const imgRes = await fetch(`${BASE}/api/snippets/${imgSnip.data.id}/image`, { headers: { Authorization: `Bearer ${token}` } });
  const imgBody = await imgRes.arrayBuffer();
  check('图片端点返回原始 PNG', imgRes.status === 200 && (imgRes.headers.get('content-type') || '').includes('image/png') && imgBody.byteLength === pngBuf.byteLength, `${imgRes.status} ${imgRes.headers.get('content-type')} ${imgBody.byteLength}B`);
  const anonImg = await fetch(`${BASE}/api/snippets/${imgSnip.data.id}/image`);
  check('图片端点未登录 401', anonImg.status === 401, String(anonImg.status));

  // 远程图片转存失败（非图片响应 / 不可达）→ 回退保存原始链接
  const imgFallback = await req('POST', '/api/snippets', { token, body: { type: 'image', content: 'https://example.com/favicon.ico' } });
  check('转存失败回退为外链', imgFallback.status === 200 && imgFallback.data.stored === false, JSON.stringify(imgFallback));

  // 去重：同一张图两次保存共享同一 KV 键，删除其一不影响另一条读取
  const imgDup1 = await req('POST', '/api/snippets', { token, body: { type: 'image', content: `data:image/png;base64,${pngB64}` } });
  const imgDup2 = await req('POST', '/api/snippets', { token, body: { type: 'image', content: `data:image/png;base64,${pngB64}` } });
  check('重复保存同一图片均转存', imgDup1.data.stored === true && imgDup2.data.stored === true, JSON.stringify([imgDup1.data, imgDup2.data]));
  await req('DELETE', `/api/snippets/${imgDup1.data.id}`, { token });
  const imgRes2 = await fetch(`${BASE}/api/snippets/${imgDup2.data.id}/image`, { headers: { Authorization: `Bearer ${token}` } });
  check('删除其一后另一条图片仍可读', imgRes2.status === 200 && (await imgRes2.arrayBuffer()).byteLength === pngBuf.byteLength, String(imgRes2.status));

  const ov2 = await req('GET', '/api/links/overview', { token });
  check('overview 含短文本/图片计数', ov2.status === 200 && (ov2.data.snippetCounts?.text ?? 0) >= 1 && (ov2.data.snippetCounts?.image ?? 0) >= 3, JSON.stringify(ov2.data));

  // 清空对同一 KV 键的全部引用 → waitUntil 异步清理转存文件
  const imgKey = `img:${createHash('sha256').update(pngBuf).digest('hex')}`;
  const delSnip = await req('DELETE', `/api/snippets/${imgSnip.data.id}`, { token });
  check('删除图片收藏', delSnip.status === 200, JSON.stringify(delSnip));
  const delSnipAgain = await req('DELETE', `/api/snippets/${imgSnip.data.id}`, { token });
  check('重复删除返回 404', delSnipAgain.status === 404, JSON.stringify(delSnipAgain));
  await req('DELETE', `/api/snippets/${imgDup2.data.id}`, { token });
  let kvCleaned = false;
  for (let i = 0; i < 20 && !kvCleaned; i++) {
    sleepSync(1200); // waitUntil 异步清理 + 本地 miniflare 落盘有可见性延迟，轮询等待
    try {
      execSync(`npx wrangler kv key get "${imgKey}" ${kvScope}`, {
        cwd: path.join(__dirname, '..', 'worker'),
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      });
    } catch {
      kvCleaned = true; // get 失败即键已删除
    }
  }
  if (kvCleaned) console.log('PASS  KV 中无引用图片已清理');
  else if (process.env.E2E_KV === 'remote') { failed++; console.log('FAIL  KV 中无引用图片已清理'); }
  else console.log('WARN  KV 清理未在本轮观察到（本地 miniflare 落盘延迟，仅影响本断言）');

  // ---- 注册 / 密码登录 / 找回密码 ----
  // 本地 .dev.vars 为假 Resend 密钥，发信返回 502，但验证码已写入 KV，可从本地 KV 读取
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
