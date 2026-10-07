'use strict';

// 与扩展 background.js 中保持一致（由 manifest 的 key 决定，更换 key 时需同步修改）
const EXTENSION_ID = 'ojokkllejggilcghafadekmldpgcmphd';

const TOKEN_KEY = 'ls_token';
const THEME_KEY = 'ls_theme';
const SSO_SKIP_KEY = 'ls_sso_skip';
const LOGGED_OUT_KEY = 'ls_logged_out';
const PAGE_SIZE = 50;

const state = {
  token: localStorage.getItem(TOKEN_KEY) || '',
  email: '',
  type: 'all', // all | site | article（链接） | text | image（选中内容）
  category: '',
  month: '',
  snipMonth: '', // 纯文本 / 图片视图的月份归档筛选
  days: 0,       // 日期快速筛选（近 N 天，0 = 全部时间）
  q: '',
  offset: 0,
  total: 0,
  linkOffset: 0,  // 「全部」视图下两个数据源各自的分页游标
  snipOffset: 0,
  overview: null,
  loading: false,
  pendingReset: false,
  hasPassword: false,
};

const DAYS_LABEL = { 1: '近 24 小时', 7: '近 7 天', 30: '近 30 天', 90: '近 90 天' };
const isSnippetType = (t) => t === 'text' || t === 'image';
const isSnippetItem = (it) => it.type === 'text' || it.type === 'image';

// 已转存图片需要带凭证读取，objectURL 按条目缓存，删除时释放
const snippetImgUrls = new Map();

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

/* ---------------- 登录 / 注册 / 找回密码 ---------------- */

function setLoginStatus(msg, info = false) {
  const el = $('login-status');
  el.textContent = msg || '';
  el.classList.toggle('info', info);
}

let authTab = 'login';        // login | register | reset
let loginMethod = 'password'; // password | code
const countdownTimers = new Map();

function startCountdown(btn, sec) {
  clearInterval(countdownTimers.get(btn));
  const label = btn.dataset.label || '发送验证码';
  btn.disabled = true;
  const finish = () => {
    clearInterval(countdownTimers.get(btn));
    countdownTimers.delete(btn);
    btn.disabled = false;
    btn.textContent = label;
  };
  countdownTimers.set(btn, setInterval(() => {
    sec -= 1;
    if (sec <= 0) return finish();
    btn.textContent = `${sec}s 后可重发`;
  }, 1000));
  btn.textContent = `${sec}s 后可重发`;
}

function showAuthView(tab) {
  authTab = tab;
  for (const t of ['login', 'register', 'reset']) {
    $(`view-${t}`).classList.toggle('hidden', t !== tab);
    document.querySelector(`.auth-tab[data-tab="${t}"]`)?.classList.toggle('active', t === tab);
  }
  $('login-email').readOnly = false;
  $('reg-email').readOnly = false;
  $('reset-email').readOnly = false;
  if (tab === 'login') applyLoginMethod();
  setLoginStatus('');
}

function applyLoginMethod() {
  $('login-password-row').classList.toggle('hidden', loginMethod !== 'password');
  $('login-code-row').classList.toggle('hidden', loginMethod !== 'code');
  $('btn-login').textContent = loginMethod === 'password' ? '登录' : '验证码登录';
  $('btn-switch-login').textContent = loginMethod === 'password' ? '使用验证码登录' : '使用密码登录';
}

// 发送各类验证码；成功后锁定邮箱并进入 60s 重发倒计时
async function sendAuthCode(path, email, sendBtn, emailInput) {
  if (!email) return setLoginStatus('请输入邮箱地址');
  setLoginStatus('正在发送验证码…', true);
  try {
    const data = await api(path, { method: 'POST', body: { email }, auth: false });
    setLoginStatus(data.message || '验证码已发送', true);
    emailInput.readOnly = true;
    startCountdown(sendBtn, 60);
    return true;
  } catch (e) {
    setLoginStatus(e.message);
    return false;
  }
}

async function doPasswordLogin() {
  const email = $('login-email').value.trim();
  const password = $('login-password').value;
  if (!email || !password) return setLoginStatus('请输入邮箱和密码');
  setLoginStatus('正在登录…', true);
  try {
    const data = await api('/auth/login', { method: 'POST', body: { email, password }, auth: false });
    enterApp(data.token, data.email);
  } catch (e) {
    setLoginStatus(e.message);
  }
}

async function doCodeLogin() {
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

async function doRegister() {
  const email = $('reg-email').value.trim();
  const password = $('reg-password').value;
  const code = $('reg-code').value.trim();
  if (!email) return setLoginStatus('请输入邮箱地址');
  if (!password) return setLoginStatus('请设置密码（至少 8 位，含字母和数字）');
  if (!/^\d{6}$/.test(code)) return setLoginStatus('请先获取并输入 6 位邮箱验证码');
  setLoginStatus('正在注册…', true);
  try {
    const data = await api('/auth/register', { method: 'POST', body: { email, password, code }, auth: false });
    enterApp(data.token, data.email);
  } catch (e) {
    setLoginStatus(e.message);
  }
}

async function doResetPassword() {
  const email = $('reset-email').value.trim();
  const code = $('reset-code').value.trim();
  const newPassword = $('reset-password').value;
  if (!email) return setLoginStatus('请输入注册邮箱');
  if (!/^\d{6}$/.test(code)) return setLoginStatus('请先获取并输入 6 位重置验证码');
  if (!newPassword) return setLoginStatus('请设置新密码（至少 8 位，含字母和数字）');
  setLoginStatus('正在重置密码…', true);
  try {
    const data = await api('/auth/reset-password', { method: 'POST', body: { email, code, new_password: newPassword }, auth: false });
    enterApp(data.token, data.email);
  } catch (e) {
    setLoginStatus(e.message);
  }
}

function logout() {
  state.token = '';
  localStorage.removeItem(TOKEN_KEY);
  // 持久退出标记：网页端退出后保持退出状态，扩展 SSO 自动登录停用，
  // 直到在网页端重新登录。与插件的登录态互不影响。
  try {
    sessionStorage.setItem(SSO_SKIP_KEY, '1');
    localStorage.setItem(LOGGED_OUT_KEY, '1');
  } catch { /* 隐私模式等场景忽略 */ }
  location.reload();
}

/* ---------------- 扩展联动自动登录 ---------------- */

// 通过 URL 中的一次性令牌登录（扩展菜单跳转 / 兜底流程）
async function loginWithOtt(ott) {
  try {
    const data = await api('/sso/exchange', { method: 'POST', body: { ott }, auth: false });
    enterApp(data.token, data.email);
    api('/auth/me').then(applyAccountInfo).catch(() => {});
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
  // 重新登录成功后清除退出标记，自动登录恢复
  try {
    sessionStorage.removeItem(SSO_SKIP_KEY);
    localStorage.removeItem(LOGGED_OUT_KEY);
  } catch { /* 忽略 */ }
  $('login-view').classList.add('hidden');
  $('app-view').classList.remove('hidden');
  $('user-email').textContent = state.email;
  refreshOverview();
  loadList(true);
}

// /auth/me 之后调用：记录账号是否已设置密码（决定「设置密码」还是「修改密码」）
function applyAccountInfo(me) {
  if (!me) return;
  state.email = me.email || state.email;
  state.hasPassword = Boolean(me.hasPassword);
  $('user-email').textContent = state.email;
  $('btn-passwd').textContent = state.hasPassword ? '修改密码' : '设置密码';
}

async function bootstrap() {
  // 1. URL 携带一次性令牌：只有插件「打开 Web 端」能签发（插件已登录），属于显式登录凭据，
  //    优先级高于网页端的退出状态——从插件打开即视为要登录，成功后会清除退出标记。
  const urlOtt = new URLSearchParams(location.search).get('ott');
  if (urlOtt) {
    history.replaceState(null, '', location.pathname);
    if (await loginWithOtt(urlOtt)) return;
  }

  // 2. 网页端点过退出：保持退出状态，跳过其余自动登录（含扩展 SSO 消息桥），
  //    直到在网页端重新登录。插件本身的登录态不受影响。
  let loggedOut = false;
  try { loggedOut = localStorage.getItem(LOGGED_OUT_KEY) === '1'; } catch { /* 忽略 */ }
  if (loggedOut) return showLogin();

  // 3. 本地已有凭证
  if (state.token) {
    try {
      const me = await api('/auth/me');
      applyAccountInfo(me);
      enterApp(state.token, me.email);
      return;
    } catch (e) {
      if (e.status === 401) {
        state.token = '';
        localStorage.removeItem(TOKEN_KEY);
      }
    }
  }

  // 4. 尝试向已登录的扩展要凭证（消息桥；退出后的标签页不自动登录）
  let ssoSkipped = false;
  try { ssoSkipped = sessionStorage.getItem(SSO_SKIP_KEY) === '1'; } catch { /* 忽略 */ }
  if (!ssoSkipped) {
    const extOtt = await requestOttFromExtension();
    if (extOtt && (await loginWithOtt(extOtt))) return;
  }

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
  // 防竞态：上一个加载未完成时新的加载请求会被丢弃，这里记录并在完成后按最新状态重载
  if (state.loading) {
    state.pendingReset = state.pendingReset || reset;
    return;
  }
  state.loading = true;
  try {
    if (state.type === 'all') {
      // 全部 = 链接 + 选中内容两个数据源并行分页，按时间归并
      const lOffset = reset ? 0 : state.linkOffset;
      const sOffset = reset ? 0 : state.snipOffset;
      const [lData, sData] = await Promise.all([
        api(`/links?${listQs({ type: 'all', limit: PAGE_SIZE, offset: lOffset })}`),
        api(`/snippets?${listQs({ limit: PAGE_SIZE, offset: sOffset })}`),
      ]);
      state.linkTotal = lData.total;
      state.snipTotal = sData.total;
      state.linkOffset = lOffset + lData.items.length;
      state.snipOffset = sOffset + sData.items.length;
      state.total = lData.total + sData.total;
      state.offset = state.linkOffset + state.snipOffset;
      const merged = [...lData.items, ...sData.items].sort((a, b) =>
        (b.created_at || '').localeCompare(a.created_at || '') || (b.id - a.id));
      renderList(merged, reset);
    } else if (isSnippetType(state.type)) {
      const offset = reset ? 0 : state.offset;
      const data = await api(`/snippets?${listQs({ type: state.type, limit: PAGE_SIZE, offset })}`);
      state.total = data.total;
      state.offset = offset + data.items.length;
      renderList(data.items, reset);
    } else {
      const offset = reset ? 0 : state.offset;
      const data = await api(`/links?${listQs({ type: state.type, limit: PAGE_SIZE, offset })}`);
      state.total = data.total;
      state.offset = offset + data.items.length;
      renderList(data.items, reset);
    }
  } catch (e) {
    if (e.status === 401) return logout();
    showToast(e.message);
  } finally {
    state.loading = false;
    if (state.pendingReset) {
      state.pendingReset = false;
      void loadList(true);
    }
  }
}

// 列表接口公共筛选参数（搜索 / 日期 / 片段月份）；分类与文章月份仅链接支持
function listQs(base) {
  const params = new URLSearchParams(base);
  if (state.q) params.set('q', state.q);
  if (state.days) params.set('days', String(state.days));
  if (isSnippetType(state.type)) {
    if (state.snipMonth) params.set('month', state.snipMonth);
  } else {
    if (state.category) params.set('category', state.category);
    if (state.month) params.set('month', state.month);
  }
  return params;
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
  const note = it.note
    ? `<button class="item-note" data-note-edit data-note="${esc(it.note)}" title="点击编辑备注">🏷 ${esc(it.note)}</button>`
    : `<button class="item-note add" data-note-edit data-note="" title="添加备注">＋ 备注</button>`;
  return `<div class="item" data-id="${it.id}">
    ${faviconHtml(it.domain)}
    <div class="item-main">
      <div class="item-title"><a href="${esc(it.url)}" target="_blank" rel="noopener noreferrer">${esc(it.title || it.url)}</a></div>
      <div class="item-meta">${badge}${note}<span>${domain}</span><span>${fmtDate(it.created_at)}</span></div>
    </div>
    <button class="item-del" title="删除" aria-label="删除">✕</button>
  </div>`;
}

function snippetHtml(it) {
  const badge = it.type === 'image' ? '<span class="badge image">图片</span>' : '<span class="badge text">纯文本</span>';
  let body;
  if (it.type === 'image') {
    // 已转存的图片走带凭证的接口；转存失败的直接用原始外链
    body = it.storage_key
      ? `<div class="snip-img"><img class="snip-thumb" data-snip-id="${it.id}" alt="收藏图片" loading="lazy" /></div>`
      : `<div class="snip-img"><img class="snip-thumb" src="${esc(it.content)}" referrerpolicy="no-referrer" alt="收藏图片" loading="lazy" onerror="this.closest('.snip-img').classList.add('broken')" /></div>`;
  } else {
    body = `<div class="snip-text">${esc(it.content)}</div>`;
  }
  const source = it.source_url
    ? `<a href="${esc(it.source_url)}" target="_blank" rel="noopener noreferrer" title="${esc(it.source_title || it.source_url)}">${esc(it.source_title || it.source_url)}</a>`
    : '';
  return `<div class="item snippet" data-id="${it.id}">
    <div class="item-main">
      ${body}
      <div class="item-meta">${badge}${source ? `<span class="snip-source">${source}</span>` : ''}<span>${fmtDate(it.created_at)}</span></div>
    </div>
    <button class="item-del" title="删除" aria-label="删除">✕</button>
  </div>`;
}

// 已转存图片需带 Authorization 拉取二进制，这里统一换取 objectURL
async function hydrateSnippetImages() {
  for (const img of document.querySelectorAll('#list img.snip-thumb[data-snip-id]')) {
    const id = img.dataset.snipId;
    if (!id) continue;
    if (snippetImgUrls.has(id)) {
      img.src = snippetImgUrls.get(id);
      continue;
    }
    try {
      const res = await fetch(`/api/snippets/${id}/image`, { headers: { Authorization: `Bearer ${state.token}` } });
      if (res.status === 401) return logout();
      if (!res.ok) throw new Error('加载失败');
      const url = URL.createObjectURL(await res.blob());
      snippetImgUrls.set(id, url);
      img.src = url;
    } catch {
      img.closest('.snip-img')?.classList.add('broken');
      img.remove();
    }
  }
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
    html += isSnippetItem(it) ? snippetHtml(it) : itemHtml(it);
  }
  listEl.insertAdjacentHTML('beforeend', html);

  const empty = $('list-empty');
  if (listEl.children.length === 0) {
    const filtered = state.category || state.month || state.snipMonth || state.q || state.days || state.type !== 'all';
    empty.textContent = isSnippetType(state.type)
      ? (state.type === 'text'
        ? '还没有保存的纯文本，去网页里选中文字，右键「保存选中文本到 Link Saver」'
        : '还没有保存的图片，去网页里右键图片，选择「保存图片到 Link Saver」')
      : filtered
        ? '没有符合条件的收藏'
        : '还没有收藏，去网页里右键「Send to Link Saver」吧';
    empty.classList.remove('hidden');
  } else {
    empty.classList.add('hidden');
  }

  $('btn-more').classList.toggle('hidden', state.offset >= state.total);
  hydrateSnippetImages();
}

/* ---------------- 侧栏 / 筛选 ---------------- */

function monthBtns(list, stype) {
  return list.length
    ? list.map((m) => `<button class="side-item${state.snipMonth === m.month && state.type === stype ? ' active' : ''}" data-smonth="${esc(m.month)}" data-stype="${stype}">
        <span class="side-name">${esc(monthLabel(m.month))}</span><span class="side-count">${m.count}</span></button>`).join('')
    : '<div class="side-empty">暂无内容</div>';
}

function renderSidebar() {
  const cats = state.overview?.categories ?? [];
  const months = state.overview?.months ?? [];
  const textMonths = state.overview?.textMonths ?? [];
  const imageMonths = state.overview?.imageMonths ?? [];

  // 四个侧栏板块常驻（与文章归档一致），点击月份归档会切换到对应视图
  $('sec-site-cats').classList.remove('hidden');
  $('sec-article-months').classList.remove('hidden');
  $('sec-text-months').classList.remove('hidden');
  $('sec-image-months').classList.remove('hidden');

  $('site-cats').innerHTML = cats.length
    ? cats.map((c) => `<button class="side-item${state.category === c.name ? ' active' : ''}" data-cat="${esc(c.name)}">
        <span class="side-name">${esc(c.name)}</span><span class="side-count">${c.count}</span></button>`).join('')
    : '<div class="side-empty">暂无网站</div>';

  $('month-list').innerHTML = months.length
    ? months.map((m) => `<button class="side-item${state.month === m.month ? ' active' : ''}" data-month="${esc(m.month)}">
        <span class="side-name">${esc(monthLabel(m.month))}</span><span class="side-count">${m.count}</span></button>`).join('')
    : '<div class="side-empty">暂无文章</div>';

  $('text-month-list').innerHTML = monthBtns(textMonths, 'text');
  $('image-month-list').innerHTML = monthBtns(imageMonths, 'image');
}

function renderTypeChips() {
  const tc = state.overview?.typeCounts ?? { site: 0, article: 0 };
  const sc = state.overview?.snippetCounts ?? { text: 0, image: 0 };
  const counts = {
    all: tc.site + tc.article + sc.text + sc.image,
    site: tc.site,
    article: tc.article,
    text: sc.text,
    image: sc.image,
  };
  const labels = { all: '全部', site: '网站', article: '文章', text: '纯文本', image: '图片' };
  document.querySelectorAll('#type-chips .chip').forEach((chip) => {
    const t = chip.dataset.type;
    const n = counts[t] ?? 0;
    chip.textContent = `${labels[t] ?? t}${n ? ` ${n}` : ''}`;
    chip.classList.toggle('active', state.type === t && !state.category && !state.month);
  });
}

function renderActiveFilters() {
  const box = $('active-filters');
  const tags = [];
  if (state.category) tags.push({ key: 'category', label: `网站：${state.category}` });
  if (state.month) tags.push({ key: 'month', label: `归档：${monthLabel(state.month)}` });
  if (state.snipMonth) tags.push({ key: 'snipMonth', label: `归档：${monthLabel(state.snipMonth)}` });
  if (state.days) tags.push({ key: 'days', label: `时间：${DAYS_LABEL[state.days] || `近 ${state.days} 天`}` });
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
  document.querySelectorAll('.auth-tab').forEach((tab) => {
    tab.addEventListener('click', () => showAuthView(tab.dataset.tab));
  });
  $('btn-switch-login').addEventListener('click', () => {
    loginMethod = loginMethod === 'password' ? 'code' : 'password';
    applyLoginMethod();
  });
  $('link-forgot').addEventListener('click', (e) => { e.preventDefault(); showAuthView('reset'); });
  $('btn-back-login').addEventListener('click', () => showAuthView('login'));

  $('btn-login').addEventListener('click', () => (loginMethod === 'password' ? doPasswordLogin() : doCodeLogin()));
  $('btn-login-code-send').addEventListener('click', () => sendAuthCode('/auth/request-code', $('login-email').value.trim(), $('btn-login-code-send'), $('login-email')));
  $('btn-register').addEventListener('click', doRegister);
  $('btn-reg-send').addEventListener('click', () => sendAuthCode('/auth/register/request-code', $('reg-email').value.trim(), $('btn-reg-send'), $('reg-email')));
  $('btn-reset').addEventListener('click', doResetPassword);
  $('btn-reset-send').addEventListener('click', () => sendAuthCode('/auth/reset/request-code', $('reset-email').value.trim(), $('btn-reset-send'), $('reset-email')));

  $('login-password').addEventListener('keydown', (e) => { if (e.key === 'Enter') doPasswordLogin(); });
  $('login-code').addEventListener('keydown', (e) => { if (e.key === 'Enter') doCodeLogin(); });
  $('login-email').addEventListener('keydown', (e) => { if (e.key === 'Enter') (loginMethod === 'password' ? $('login-password') : $('login-code')).focus(); });
  $('reg-password').addEventListener('keydown', (e) => { if (e.key === 'Enter') doRegister(); });
  $('reg-code').addEventListener('keydown', (e) => { if (e.key === 'Enter') doRegister(); });
  $('reg-email').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('reg-password').focus(); });
  $('reset-code').addEventListener('keydown', (e) => { if (e.key === 'Enter') doResetPassword(); });
  $('reset-password').addEventListener('keydown', (e) => { if (e.key === 'Enter') doResetPassword(); });
  $('reset-email').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('reset-code').focus(); });

  $('btn-logout').addEventListener('click', logout);

  $('type-chips').addEventListener('click', (e) => {
    const chip = e.target.closest('.chip');
    if (!chip) return;
    applyFilter({ type: chip.dataset.type, category: '', month: '', snipMonth: '' });
  });

  $('sidebar').addEventListener('click', (e) => {
    const cat = e.target.closest('[data-cat]');
    if (cat) return applyFilter({ type: 'site', category: state.category === cat.dataset.cat ? '' : cat.dataset.cat, month: '' });
    const month = e.target.closest('[data-month]');
    if (month) return applyFilter({ type: 'article', month: state.month === month.dataset.month ? '' : month.dataset.month, category: '' });
    const smonth = e.target.closest('[data-smonth]');
    if (smonth) {
      // 点击纯文本/图片的月份归档：切换到对应视图并按月份筛选，再点一次取消筛选
      const toggle = state.snipMonth === smonth.dataset.smonth && state.type === smonth.dataset.stype ? '' : smonth.dataset.smonth;
      return applyFilter({ type: smonth.dataset.stype, snipMonth: toggle, category: '', month: '' });
    }
  });

  $('active-filters').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-clear]');
    if (!btn) return;
    applyFilter({ [btn.dataset.clear]: btn.dataset.clear === 'days' ? 0 : '' });
  });

  $('date-select').addEventListener('change', (e) => {
    applyFilter({ days: Number(e.target.value) || 0 });
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
      const isSnippet = itemEl.classList.contains('snippet');
      if (!confirm(isSnippet ? '确定删除这条内容吗？' : '确定删除这条收藏吗？')) return;
      const id = itemEl.dataset.id;
      try {
        await api(`/${isSnippet ? 'snippets' : 'links'}/${id}`, { method: 'DELETE' });
        state.total -= 1;
        // 已加载条数同步回退，避免「加载更多」漏掉前移的一条
        if (state.offset > 0) state.offset -= 1;
        const url = snippetImgUrls.get(id);
        if (url) {
          URL.revokeObjectURL(url);
          snippetImgUrls.delete(id);
        }
        // 重拉当前视图：同步空状态/加载更多按钮/总数
        await Promise.all([refreshOverview(), loadList(true)]);
      } catch (err) {
        showToast(err.message);
      }
      return;
    }
    const snipText = e.target.closest('.snip-text');
    if (snipText) {
      snipText.classList.toggle('expanded');
      return;
    }
    const noteChip = e.target.closest('[data-note-edit]');
    if (noteChip) {
      startNoteEdit(noteChip);
      return;
    }
    const thumb = e.target.closest('.snip-thumb');
    if (thumb && thumb.src) {
      const box = $('img-lightbox');
      box.querySelector('img').src = thumb.src;
      box.classList.remove('hidden');
      return;
    }
    const domainEl = e.target.closest('.item-domain');
    if (domainEl) applyFilter({ type: 'site', category: domainEl.dataset.domain, month: '' });
  });

  $('img-lightbox').addEventListener('click', () => {
    const box = $('img-lightbox');
    box.querySelector('img').src = '';
    box.classList.add('hidden');
  });

  $('btn-theme').addEventListener('click', () => {
    const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    localStorage.setItem(THEME_KEY, next);
    applyTheme(next);
  });

  // 修改密码弹窗
  $('btn-passwd').addEventListener('click', () => {
    $('pw-modal-title').textContent = state.hasPassword ? '修改密码' : '设置密码';
    $('pw-old-row').classList.toggle('hidden', !state.hasPassword);
    $('pw-old').value = '';
    $('pw-new').value = '';
    $('pw-new2').value = '';
    setPwMsg('');
    $('pw-modal').classList.remove('hidden');
    (state.hasPassword ? $('pw-old') : $('pw-new')).focus();
  });
  const closePwModal = () => $('pw-modal').classList.add('hidden');
  $('btn-pw-cancel').addEventListener('click', closePwModal);
  $('pw-modal').addEventListener('click', (e) => { if (e.target === $('pw-modal')) closePwModal(); });
  $('pw-new2').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('btn-pw-save').click(); });
  $('btn-pw-save').addEventListener('click', async () => {
    const oldPw = $('pw-old').value;
    const newPw = $('pw-new').value;
    if (state.hasPassword && !oldPw) return setPwMsg('请输入当前密码');
    if (!newPw) return setPwMsg('请输入新密码');
    if (newPw !== $('pw-new2').value) return setPwMsg('两次输入的新密码不一致');
    setPwMsg('正在保存…', true);
    try {
      const data = await api('/auth/change-password', { method: 'POST', body: { old_password: oldPw, new_password: newPw } });
      closePwModal();
      state.hasPassword = true;
      $('btn-passwd').textContent = '修改密码';
      showToast(data.message || '密码已修改');
    } catch (e) {
      if (e.status === 401) return logout();
      setPwMsg(e.message);
    }
  });
}

/* ---------------- 修改密码弹窗 ---------------- */

function setPwMsg(text, info = false) {
  const el = $('pw-msg');
  el.textContent = text || '';
  el.classList.toggle('info', info);
}

/* ---------------- 备注编辑 ---------------- */

// 点击备注标签 → 就地变为输入框：Enter 保存、Esc 取消、失焦取消
function startNoteEdit(chip) {
  const itemEl = chip.closest('.item');
  const id = itemEl?.dataset.id;
  if (!id) return;
  const current = chip.dataset.note || '';

  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'note-input';
  input.value = current;
  input.maxLength = 100;
  input.placeholder = '备注名称（留空清除）';
  chip.replaceWith(input);
  input.focus();
  input.select();

  let settled = false;
  const finish = (save) => {
    if (settled) return;
    settled = true;
    const val = input.value.trim();
    input.replaceWith(chip);
    if (!save || val === current) return;
    api(`/links/${id}`, { method: 'PATCH', body: { note: val } })
      .then((data) => {
        chip.dataset.note = data.note;
        chip.textContent = data.note ? `🏷 ${data.note}` : '＋ 备注';
        chip.classList.toggle('add', !data.note);
      })
      .catch((e) => {
        if (e.status === 401) return logout();
        showToast(e.message);
      });
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') finish(true);
    else if (e.key === 'Escape') finish(false);
  });
  input.addEventListener('blur', () => finish(false));
}

/* ---------------- 暗黑模式 ---------------- */

function applyTheme(mode) {
  document.documentElement.dataset.theme = mode;
  const btn = $('btn-theme');
  if (btn) btn.textContent = mode === 'dark' ? '☀️' : '🌙';
}

function initTheme() {
  const saved = localStorage.getItem(THEME_KEY);
  const dark = saved ? saved === 'dark' : window.matchMedia('(prefers-color-scheme: dark)').matches;
  applyTheme(dark ? 'dark' : 'light');
}

bindEvents();
initTheme();
bootstrap();
