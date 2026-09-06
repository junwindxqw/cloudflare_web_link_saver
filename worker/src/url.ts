import { ARTICLE_CATEGORY } from './types';

/**
 * 校验 hostname 是否为环回/私有/保留地址，禁止保存或抓取此类目标。
 */
export function isPrivateHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/\.$/, '');
  if (!h) return true;
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal') || h.endsWith('.home.arpa')) {
    return true;
  }
  if (h.startsWith('[')) {
    const v6 = h.slice(1, -1).split('%')[0];
    if (v6 === '::1' || v6 === '::') return true;
    const first = (v6.split(':')[0] || '').toLowerCase();
    return /^f[cd]/.test(first) || /^fe[89ab]/.test(first);
  }
  const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m) {
    const octets = m.slice(1).map(Number);
    if (octets.some((n) => n > 255)) return true;
    const [a, b] = octets;
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    if (a === 198 && (b === 18 || b === 19)) return true;
    if (a >= 224) return true;
    return false;
  }
  return false;
}

export function assertPublicHttpUrl(raw: string): URL {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error('URL 格式不正确');
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new Error('仅支持 http/https 网址');
  }
  if (isPrivateHost(u.hostname)) {
    throw new Error('不支持保存内网或保留地址');
  }
  return u;
}

export type Classification = {
  type: 'site' | 'article';
  category: string;
  domain: string;
  canonical: string;
};

/**
 * 纯域名（路径为空或 /）→ 网站，分类即域名；
 * 其它页面 → 文章，归入文章分类并记录所属域名。
 */
const TRACKING_PARAMS = new Set([
  'fbclid', 'gclid', 'msclkid', 'igshid', 'mc_cid', 'mc_eid',
  '_hsenc', '_hsmi', 'spm', 'ref', 'ref_src', 'ref_url',
]);

function isTrackingParam(key: string): boolean {
  const k = key.toLowerCase();
  return k.startsWith('utm_') || TRACKING_PARAMS.has(k);
}

export function classifyUrl(u: URL): Classification {
  const domain = u.hostname.toLowerCase();
  if (u.pathname === '' || u.pathname === '/') {
    return { type: 'site', category: domain, domain, canonical: u.origin + '/' };
  }
  // 归一化：剥离锚点与常见追踪参数，避免同一文章因入口不同存成多条
  u.hash = '';
  for (const key of [...u.searchParams.keys()]) {
    if (isTrackingParam(key)) u.searchParams.delete(key);
  }
  return { type: 'article', category: ARTICLE_CATEGORY, domain, canonical: u.toString() };
}

const ENTITIES: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&#x27;': "'",
  '&nbsp;': ' ',
};

function decodeEntities(s: string): string {
  return s.replace(/&(?:amp|lt|gt|quot|#39|#x27|nbsp);/gi, (m) => ENTITIES[m.toLowerCase()] ?? m);
}

/**
 * 流式读取响应体前 maxBytes 字节，读到 </title> 提前收尾，避免大页面撑爆内存。
 */
async function readBodyHead(res: Response, maxBytes: number): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return '';
  const decoder = new TextDecoder();
  let out = '';
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      out += decoder.decode(value, { stream: true });
      if (out.includes('</title>') || bytes >= maxBytes) break;
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  out += decoder.decode();
  return out;
}

/**
 * 服务端尽力抓取页面 <title>。手动跟随重定向，每一跳都重新校验目标地址。
 */
export async function fetchPageTitle(url: string): Promise<string | null> {
  let current = url;
  for (let i = 0; i < 3; i++) {
    let u: URL;
    try {
      u = assertPublicHttpUrl(current);
    } catch {
      return null;
    }
    let res: Response;
    try {
      res = await fetch(u, {
        redirect: 'manual',
        signal: AbortSignal.timeout(5000),
        headers: { 'user-agent': 'Mozilla/5.0 (compatible; LinkSaver/1.0)' },
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
    const ct = res.headers.get('content-type') || '';
    if (!ct.includes('html') && !ct.includes('text')) return null;
    let text: string;
    try {
      // 读响应体同样受 AbortSignal 超时约束，可能抛出 TimeoutError
      text = await readBodyHead(res, 256 * 1024);
    } catch {
      return null;
    }
    const m = text.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    if (!m) return null;
    const title = decodeEntities(m[1]).replace(/\s+/g, ' ').trim().slice(0, 300);
    return title || null;
  }
  return null;
}

export function fallbackTitle(u: URL): string {
  const segs = u.pathname.split('/').filter(Boolean);
  const last = segs[segs.length - 1];
  if (last) {
    try {
      const name = decodeURIComponent(last).replace(/\.[a-z0-9]+$/i, '').replace(/[-_]+/g, ' ').trim();
      if (name) return name.slice(0, 300);
    } catch {
      /* 忽略解码失败 */
    }
  }
  return u.hostname;
}
