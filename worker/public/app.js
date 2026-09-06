'use strict';

// 与扩展 background.js 中保持一致（由 manifest 的 key 决定，更换 key 时需同步修改）
const EXTENSION_ID = 'ojokkllejggilcghafadekmldpgcmphd';

const TOKEN_KEY = 'ls_token';
const PAGE_SIZE = 50;

const state = {
  token: localStorage.getItem(TOKEN_KEY) || '',
  email: '',
  type: 'all', // all | site | article
  category: '',
  month: '',
  q: '',
  offset: 0,
  total: 0,
  overview: null,
  loading: false,
};

const $ = (id) => document.getElementById(id);

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[ch]));
}

function showToast(msg, ms = 2200) {
  const el = $('toast');
  el.textContent = msg;
  el.classList.remove('hidden');
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => el.classList.add('hidden'), ms);
}

/* ---------------- API ---------------- */

async function api(path, { method = 'GET', body, auth = true } = {}) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (auth && state.token) headers['Authorization'] = `Bearer ${state.token}`;
  const res = await fetch(`/api${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let data = {};
  try { data = await res.json(); } catch { /* 非 JSON 响应 */ }
  if (!res.ok) {
    const err = new Error(data.error || `请求失败(${res.status})`);
    err.status = res.status;
    throw err;
  }
  return data;
}

/* ---------------- 登录 ---------------- */

function setLoginStatus(msg, info = false) {
  const el = $('login-status');
  el.textContent = msg || '';
  el.classList.toggle('info', info);
}

let loginStage = 'email'; // email | code

function switchLoginStage(stage) {
  loginStage = stage;
  $('code-row').classList.toggle('hidden', stage !== 'code');
  // 验证码阶段锁定邮箱，避免改邮箱后拿 A 的码验证 B
  $('login-email').readOnly = stage === 'code';
  $('btn-main').textContent = stage === 'email' ? '发送验证码' : '登录';
}

async function requestCode() {
  const email = $('login-email').value.trim();
  if (!email) return setLoginStatus('请输入邮箱地址');
  setLoginStatus('正在发送验证码…', true);
  try {
    const data = await api('/auth/request-code', { method: 'POST', body: { email }, auth: false });
    setLoginStatus(data.message || '验证码已发送', true);
    switchLoginStage('code');
    $('login-code').focus();
    startResendCountdown(60);
  } catch (e) {
    setLoginStatus(e.message);
  }
}

let resendTimer = null;
function startResendCountdown(sec) {
  const btn = $('btn-resend');
  btn.disabled = true;
  clearInterval(resendTimer);
  resendTimer = setInterval(() => {
    sec -= 1;
    btn.textContent = sec > 0 ? `${sec}s 后可重发` : '重新发送';
    if (sec <= 0) { clearInterval(resendTimer); btn.disabled = false; }
  }, 1000);
  btn.textContent = `${sec}s 后可重发`;
}

async function verifyCode() {
  const email = $('login-email').value.trim();
  const code = $('login-code').value.trim();
  if (!email) return setLoginStatus('请输入邮箱地址');
  if (!/^\d{6}$/.test(code)) return setLoginStatus('请输入 6 位数字验证码');
  setLoginStatus('正在登录…', true);
  try {
    const data = await api('/auth/verify', { method: 'POST', body: { email, code }, auth: false });
    enterApp(data.token, data.email);
  } catch (e) {
    setLoginStatus(e.message);
  }
}

function logout() {
  state.token = '';
  localStorage.removeItem(TOKEN_KEY);
  location.reload();
}

/* ---------------- 扩展联动自动登录 ---------------- */

// 通过 URL 中的一次性令牌登录（扩展菜单跳转 / 兜底流程）
async function loginWithOtt(ott) {
  try {
    const data = await api('/sso/exchange', { method: 'POST', body: { ott }, auth: false });
    enterApp(data.token, data.email);
    return true;
  } catch {
    return false;
  }
}

// 已登录扩展在后台签发一次性令牌，页面直接换取正式凭证
function requestOttFromExtension() {
  return new Promise((resolve) => {
    if (!window.chrome || !chrome.runtime || typeof chrome.runtime.sendMessage !== 'function') {
      return resolve(null);
    }
    let settled = false;
    // 覆盖扩展 service worker 冷启动 + 网络往返的时间
    const timer = setTimeout(() => { if (!settled) { settled = true; resolve(null); } }, 3500);
    try {
      chrome.runtime.sendMessage(EXTENSION_ID, { type: 'LINK_SAVER_GET_OTT' }, (res) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        void chrome.runtime.lastError; // 未安装扩展时会设置 lastError，读取以避免控制台报错
        resolve(res && res.ok ? res.ott : null);
      });
    } catch {
      clearTimeout(timer);
      resolve(null);
    }
  });
}

/* ---------------- 视图切换 ---------------- */

function enterApp(token, email) {
  state.token = token;
  state.email = email || '';
  if (token) localStorage.setItem(TOKEN_KEY, token);
  $('login-view').classList.add('hidden');
  $('app-view').classList.remove('hidden');
  $('user-email').textContent = state.email;
  refreshOverview();
  loadList(true);
}

async function bootstrap() {
  // 1. URL 携带一次性令牌（扩展菜单打开 /sso/ott 流程）
  const params = new URLSearchParams(location.search);
  const ott = params.get('ott');
  if (ott) {
    history.replaceState(null, '', location.pathname);
    if (await loginWithOtt(ott)) return;
  }

  // 2. 本地已有凭证
  if (state.token) {
    try {
      const me = await api('/auth/me');
      enterApp(state.token, me.email);
      return;
    } catch (e) {
      if (e.status === 401) {
        state.token = '';
        localStorage.removeItem(TOKEN_KEY);
      }
    }
  }

  // 3. 尝试向已登录的扩展要凭证
  const extOtt = await requestOttFromExtension();
  if (extOtt && (await loginWithOtt(extOtt))) return;

  showLogin();
}

function showLogin() {
  $('login-view').classList.remove('hidden');
  $('app-view').classList.add('hidden');
}

/* ---------------- 列表 ---------------- */

async function refreshOverview() {
  try {
    state.overview = await api('/links/overview');
    renderSidebar();
    renderTypeChips();
  } catch (e) {
    if (e.status === 401) return logout();
    console.error(e);
  }
}

async function loadList(reset = false) {
  if (state.loading) return;
  state.loading = true;
  const offset = reset ? 0 : state.offset;
  try {
    const params = new URLSearchParams({ type: state.type, limit: String(PAGE_SIZE), offset: String(offset) });
    if (state.category) params.set('category', state.category);
    if (state.month) params.set('month', state.month);
    if (state.q) params.set('q', state.q);
    const data = await api(`/links?${params}`);
    state.total = data.total;
    state.offset = offset + data.items.length;
    renderList(data.items, reset);
  } catch (e) {
    if (e.status === 401) return logout();
    showToast(e.message);
  } finally {
    state.loading = false;
  }
}

function monthLabel(m) {
  const [y, mm] = m.split('-');
  return `${y} 年 ${Number(mm)} 月`;
}

function fmtDate(s) {
  const d = new Date(s.includes('T') ? s : s.replace(' ', 'T') + 'Z');
  if (Number.isNaN(d.getTime())) return s;
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const yesterday = new Date(now); yesterday.setDate(now.getDate() - 1);
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  if (sameDay) return `今天 ${hm}`;
  if (d.toDateString() === yesterday.toDateString()) return `昨天 ${hm}`;
  const y = d.getFullYear() === now.getFullYear() ? '' : `${d.getFullYear()} 年 `;
  return `${y}${d.getMonth() + 1} 月 ${d.getDate()} 日`;
}

function faviconHtml(domain) {
  let hash = 0;
  for (const ch of domain) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  const hue = hash % 360;
  const letter = esc((domain.replace(/^www\./, '')[0] || '?').toUpperCase());
  const img = `<img src="https://www.google.com/s2/favicons?sz=64&domain=${encodeURIComponent(domain)}" alt="" onerror="this.remove()" loading="lazy" />`;
  return `<span class="fav" style="background:hsl(${hue},62%,52%)">${letter}${img}</span>`;
}

function itemHtml(it) {
  const badge = it.type === 'site' ? '<span class="badge site">网站</span>' : '<span class="badge article">文章</span>';
  const domain = it.type === 'article'
    ? `<span class="item-domain" data-domain="${esc(it.domain)}" title="查看该网站分类">${esc(it.domain)}</span>`
    : esc(it.domain);
  return `<div class="item" data-id="${it.id}">
    ${faviconHtml(it.domain)}
    <div class="item-main">
      <div class="item-title"><a href="${esc(it.url)}" target="_blank" rel="noopener noreferrer">${esc(it.title || it.url)}</a></div>
      <div class="item-meta">${badge}<span>${domain}</span><span>${fmtDate(it.created_at)}</span></div>
    </div>
    <button class="item-del" title="删除" aria-label="删除">✕</button>
  </div>`;
}

function renderList(items, reset) {
  const listEl = $('list');
  if (reset) listEl.innerHTML = '';

  let html = '';
  let lastMonth = null;
  // 文章视图按月份归档展示
  const groupByMonth = state.type === 'article';
  for (const it of items) {
    if (groupByMonth) {
      const m = (it.created_at || '').slice(0, 7);
      if (m && m !== lastMonth) {
        html += `<div class="group-header">${esc(monthLabel(m))}</div>`;
        lastMonth = m;
      }
    }
    html += itemHtml(it);
  }
  listEl.insertAdjacentHTML('beforeend', html);

  const empty = $('list-empty');
  if (listEl.children.length === 0) {
    const filtered = state.category || state.month || state.q || state.type !== 'all';
    empty.textContent = filtered ? '没有符合条件的收藏' : '还没有收藏，去网页里右键「Send to Link Saver」吧';
    empty.classList.remove('hidden');
  } else {
    empty.classList.add('hidden');
  }

  $('btn-more').classList.toggle('hidden', state.offset >= state.total);
}

/* ---------------- 侧栏 / 筛选 ---------------- */

function renderSidebar() {
  const cats = state.overview?.categories ?? [];
  const months = state.overview?.months ?? [];

  $('site-cats').innerHTML = cats.length
    ? cats.map((c) => `<button class="side-item${state.category === c.name ? ' active' : ''}" data-cat="${esc(c.name)}">
        <span class="side-name">${esc(c.name)}</span><span class="side-count">${c.count}</span></button>`).join('')
    : '<div class="side-empty">暂无网站</div>';

  $('month-list').innerHTML = months.length
    ? months.map((m) => `<button class="side-item${state.month === m.month ? ' active' : ''}" data-month="${esc(m.month)}">
        <span class="side-name">${esc(monthLabel(m.month))}</span><span class="side-count">${m.count}</span></button>`).join('')
    : '<div class="side-empty">暂无文章</div>';
}

function renderTypeChips() {
  const tc = state.overview?.typeCounts ?? { site: 0, article: 0 };
  document.querySelectorAll('#type-chips .chip').forEach((chip) => {
    const t = chip.dataset.type;
    const n = t === 'all' ? tc.site + tc.article : tc[t];
    chip.textContent = `${t === 'all' ? '全部' : t === 'site' ? '网站' : '文章'}${n ? ` ${n}` : ''}`;
    chip.classList.toggle('active', state.type === t && !state.category && !state.month);
  });
}

function renderActiveFilters() {
  const box = $('active-filters');
  const tags = [];
  if (state.category) tags.push({ key: 'category', label: `网站：${state.category}` });
  if (state.month) tags.push({ key: 'month', label: `归档：${monthLabel(state.month)}` });
  if (state.q) tags.push({ key: 'q', label: `搜索：${state.q}` });
  box.innerHTML = tags
    .map((t) => `<span class="filter-tag">${esc(t.label)}<button data-clear="${t.key}" aria-label="移除筛选">✕</button></span>`)
    .join('');
}

async function applyFilter(patch) {
  Object.assign(state, patch);
  renderSidebar();
  renderTypeChips();
  renderActiveFilters();
  await loadList(true);
}

/* ---------------- 事件绑定 ---------------- */

function bindEvents() {
  $('btn-main').addEventListener('click', () => (loginStage === 'email' ? requestCode() : verifyCode()));
  $('btn-resend').addEventListener('click', requestCode);
  $('login-code').addEventListener('keydown', (e) => { if (e.key === 'Enter') verifyCode(); });
  $('login-email').addEventListener('keydown', (e) => { if (e.key === 'Enter') requestCode(); });

  $('btn-logout').addEventListener('click', logout);

  $('type-chips').addEventListener('click', (e) => {
    const chip = e.target.closest('.chip');
    if (!chip) return;
    applyFilter({ type: chip.dataset.type, category: '', month: '' });
  });

  $('sidebar').addEventListener('click', (e) => {
    const cat = e.target.closest('[data-cat]');
    if (cat) return applyFilter({ type: 'site', category: state.category === cat.dataset.cat ? '' : cat.dataset.cat, month: '' });
    const month = e.target.closest('[data-month]');
    if (month) return applyFilter({ type: 'article', month: state.month === month.dataset.month ? '' : month.dataset.month, category: '' });
  });

  $('active-filters').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-clear]');
    if (!btn) return;
    applyFilter({ [btn.dataset.clear]: '' });
  });

  let searchTimer = null;
  $('search-input').addEventListener('input', (e) => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => applyFilter({ q: e.target.value.trim() }), 400);
  });

  $('btn-more').addEventListener('click', () => loadList(false));

  $('list').addEventListener('click', async (e) => {
    const del = e.target.closest('.item-del');
    if (del) {
      const itemEl = del.closest('.item');
      if (!confirm('确定删除这条收藏吗？')) return;
      try {
        await api(`/links/${itemEl.dataset.id}`, { method: 'DELETE' });
        itemEl.remove();
        state.total -= 1;
        // 已加载条数同步回退，避免「加载更多」漏掉前移的一条
        if (state.offset > 0) state.offset -= 1;
        refreshOverview();
      } catch (err) {
        showToast(err.message);
      }
      return;
    }
    const domainEl = e.target.closest('.item-domain');
    if (domainEl) applyFilter({ type: 'site', category: domainEl.dataset.domain, month: '' });
  });
}

bindEvents();
bootstrap();
