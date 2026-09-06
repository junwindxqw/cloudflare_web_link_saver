// 生产环境认证流程验证：注册 → 密码登录 → 忘记密码重置 → 新密码登录
// 用 gmail +alias 注册独立测试账号，不影响主账号
const { execSync } = require('child_process');
const BASE = 'https://link-saver.junwind.site';
const EMAIL = 'redacted-e2e@example.com';
const NS = 'c9a2e5f1d5b1423c91f8a3a05e24e84e';
const PW1 = 'E2eTest' + Math.floor(Math.random() * 900000 + 100000);
const PW2 = 'E2eReset' + Math.floor(Math.random() * 900000 + 100000);

async function fetchRetry(url, opts = {}, tries = 3) {
  for (let i = 1; i <= tries; i++) {
    try {
      return await fetch(url, { ...opts, signal: AbortSignal.timeout(30000) });
    } catch (e) {
      if (i === tries) throw e;
      console.log(`  网络抖动，重试 ${i}/${tries - 1}…`);
      await new Promise((r) => setTimeout(r, 2000 * i));
    }
  }
}
const j = async (r) => ({ status: r.status, data: await r.json().catch(() => ({})) });

function readRemoteCode(purpose, email) {
  const raw = execSync(`npx wrangler kv key get "code:${purpose}:${email}" --namespace-id ${NS} --remote`, {
    cwd: __dirname + '/../worker',
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  return JSON.parse(raw.replace(/\x1b\[[0-9;]*m/g, '').trim().split('\n').pop()).code;
}

let failed = 0;
const check = (name, cond, detail = '') => {
  if (cond) console.log(`PASS  ${name}`);
  else { failed++; console.log(`FAIL  ${name}  ${detail}`); }
};

(async () => {
  let r = await j(await fetchRetry(BASE + '/api/auth/register/request-code', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: EMAIL }) }));
  if (r.status === 409) { console.log('测试账号已存在，改走重置流程'); }
  else check('注册验证码已发送(Resend)', r.status === 200, JSON.stringify(r.data));

  let token = null;
  if (r.status === 200) {
    const code = readRemoteCode('register', EMAIL);
    const reg = await j(await fetchRetry(BASE + '/api/auth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: EMAIL, password: PW1, code }) }));
    check('注册成功并返回凭证', reg.status === 200 && reg.data.token, JSON.stringify(reg.data));
    token = reg.data.token;
  }

  const login1 = await j(await fetchRetry(BASE + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: EMAIL, password: PW1 }) }));
  check('密码登录', login1.status === 200 && login1.data.token, JSON.stringify(login1.data));
  token = login1.data.token || token;

  r = await j(await fetchRetry(BASE + '/api/auth/reset/request-code', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: EMAIL }) }));
  check('重置验证码已发送', r.status === 200 && r.data.ok, JSON.stringify(r.data));
  const resetCode = readRemoteCode('reset', EMAIL);

  const reset = await j(await fetchRetry(BASE + '/api/auth/reset-password', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: EMAIL, code: resetCode, new_password: PW2 }) }));
  check('重置密码成功', reset.status === 200 && reset.data.token, JSON.stringify(reset.data));

  const oldPw = await j(await fetchRetry(BASE + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: EMAIL, password: PW1 }) }));
  check('旧密码已失效', oldPw.status === 401, JSON.stringify(oldPw.data));

  const newPw = await j(await fetchRetry(BASE + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: EMAIL, password: PW2 }) }));
  check('新密码可登录', newPw.status === 200 && newPw.data.token, JSON.stringify(newPw.data));
  token = newPw.data.token || token;

  // 顺手验证登录态可用：保存一条收藏再删除
  if (token) {
    const save = await j(await fetchRetry(BASE + '/api/links', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ url: 'https://github.com/', title: 'GitHub' }) }));
    check('登录态保存收藏', save.status === 200, JSON.stringify(save.data));
    const list = await j(await fetchRetry(BASE + '/api/links?type=site', { headers: { Authorization: `Bearer ${token}` } }));
    const item = (list.data.items || []).find((i) => i.category === 'github.com');
    if (item) {
      const del = await j(await fetchRetry(BASE + `/api/links/${item.id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } }));
      console.log(`（清理测试收藏: ${del.status}）`);
    }
  }

  console.log(failed ? `\n${failed} 项失败` : '\n生产认证流程验证通过');
  process.exit(failed ? 1 : 0);
})();
