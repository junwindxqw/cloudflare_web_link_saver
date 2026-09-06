// 运行时安全实证：SQL 注入载荷应为惰性字面量；CORS 仅回显白名单来源
const crypto = require('crypto');
const BASE = process.env.E2E_BASE || 'http://127.0.0.1:8787';

function b64url(s) { return Buffer.from(s).toString('base64url'); }
const head = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
const now = Math.floor(Date.now() / 1000);
const body = b64url(JSON.stringify({ sub: '1', email: 'tester@junwind.site', iat: now, exp: now + 3600 }));
const sig = crypto.createHmac('sha256', 'local-e2e-secret').update(`${head}.${body}`).digest('base64url');
const token = `${head}.${body}.${sig}`;
const H = { Authorization: `Bearer ${token}` };

(async () => {
  const before = await (await fetch(`${BASE}/api/links`, { headers: H })).json();

  console.log('---- 1. SQL 注入载荷（q 参数 / category 参数）----');
  const payloads = [
    "%' OR 1=1 --",
    "'; DROP TABLE links;--",
    "%' UNION SELECT 1,2,3,4,5,6,7,8 --",
  ];
  for (const q of payloads) {
    const r = await fetch(`${BASE}/api/links?q=${encodeURIComponent(q)}`, { headers: H });
    const d = await r.json();
    console.log(`q=${JSON.stringify(q)} -> HTTP ${r.status}, items=${(d.items || []).length}, total=${d.total}`);
  }
  const cat = await fetch(`${BASE}/api/links?category=${encodeURIComponent("x' OR '1'='1")}`, { headers: H });
  console.log(`category 注入 -> HTTP ${cat.status}, items=${((await cat.json()).items || []).length}`);

  const after = await (await fetch(`${BASE}/api/links`, { headers: H })).json();
  console.log(`数据完好: before=${before.total} 条, after=${after.total} 条 ${before.total === after.total && after.total > 0 ? '（DROP/UNION 未生效）' : '（异常！）'}`);

  console.log('---- 2. CORS 来源校验（ACAO = Access-Control-Allow-Origin）----');
  const origins = [
    'https://link-saver.junwind.site',
    'chrome-extension://ojokkllejggilcghafadekmldpgcmphd',
    'chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    'https://evil.example.com',
    'http://localhost:3000',
    null,
  ];
  for (const origin of origins) {
    const r = await fetch(`${BASE}/api/health`, { headers: origin ? { Origin: origin } : {} });
    const acao = r.headers.get('access-control-allow-origin');
    console.log(`Origin=${(origin || '(无)').padEnd(48)} -> ACAO: ${acao ?? '(未返回 → 浏览器拒绝跨域读取)'}`);
  }
})();
