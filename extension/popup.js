import { API_BASE, WEB_ORIGIN } from './config.js';

const $ = (id) => document.getElementById(id);
const state = { token: null, email: null, mode: 'password' };

// 统一的 JSON 请求封装：参数通过请求体传递，不做任何字符串拼接
async function postJson(path, payload) {
  const res = await fetch(`${API_BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `请求失败(${res.status})`);
  return data;
}

function setMsg(text, info = false) {
  const el = $('msg');
  el.textContent = text || '';
  el.classList.toggle('info', info);
}

function render() {
  $('logged-in').classList.toggle('hidden', !state.token);
  $('logged-out').classList.toggle('hidden', Boolean(state.token));
  if (state.token) {
    $('user-email').textContent = state.email || '';
    return;
  }
  const isCode = state.mode === 'code';
  $('tab-pw').classList.toggle('active', !isCode);
  $('tab-code').classList.toggle('active', isCode);
  $('pw-row').classList.toggle('hidden', isCode);
  $('code-row').classList.toggle('hidden', !isCode);
}

// 记住最近输入的邮箱：发送验证码 / 登录时保存，下次打开弹窗自动带出
async function rememberEmail(email) {
  if (!email) return;
  await chrome.storage.local.set({ last_email: email });
}

async function restoreEmail() {
  const { last_email } = await chrome.storage.local.get('last_email');
  if (last_email && !$('email').value) $('email').value = last_email;
}

let sendTimer = null;
function startCountdown(sec) {
  const btn = $('btn-send');
  const label = btn.dataset.label;
  btn.disabled = true;
  clearInterval(sendTimer);
  const finish = () => {
    clearInterval(sendTimer);
    sendTimer = null;
    btn.disabled = false;
    btn.textContent = label;
  };
  const tick = () => {
    if (sec <= 0) return finish();
    btn.textContent = `${sec}s 后可重发`;
    sec -= 1;
  };
  tick();
  sendTimer = setInterval(tick, 1000);
}

async function sendCode() {
  const email = $('email').value.trim();
  if (!email) return setMsg('请输入邮箱地址');
  setMsg('正在发送验证码…', true);
  try {
    const data = await postJson('/api/auth/request-code', { email });
    await rememberEmail(email);
    setMsg(data.message || '验证码已发送', true);
    startCountdown(60);
    $('code').focus();
  } catch (e) {
    setMsg(e.message);
  }
}

async function loginPassword() {
  const email = $('email').value.trim();
  const password = $('password').value;
  if (!email || !password) return setMsg('请输入邮箱和密码');
  setMsg('正在登录…', true);
  try {
    const data = await postJson('/api/auth/login', { email, password });
    await rememberEmail(email);
    state.token = data.token;
    state.email = data.email;
    await chrome.storage.local.set({ token: data.token, email: data.email });
    setMsg('');
    render();
  } catch (e) {
    setMsg(e.message);
  }
}

async function verifyCode() {
  const email = $('email').value.trim();
  const code = $('code').value.trim();
  if (!email) return setMsg('请输入邮箱地址');
  if (!/^\d{6}$/.test(code)) return setMsg('请输入 6 位数字验证码');
  setMsg('正在登录…', true);
  try {
    const data = await postJson('/api/auth/verify', { email, code });
    await rememberEmail(email);
    state.token = data.token;
    state.email = data.email;
    await chrome.storage.local.set({ token: data.token, email: data.email });
    setMsg('');
    render();
  } catch (e) {
    setMsg(e.message);
  }
}

async function saveCurrentPage() {
  // 通过 windows.getCurrent(populate) 取活动标签页，等价于 tabs 查询
  const win = await chrome.windows.getCurrent({ populate: true });
  const tabs = win.tabs || [];
  const tab = tabs.find((t) => t.active) || tabs[0];
  if (!tab?.url) return setMsg('无法获取当前页面');
  const btn = $('btn-save');
  btn.disabled = true;
  btn.textContent = '保存中…';
  // 保存逻辑与角标反馈在 background.js 中统一处理
  await chrome.runtime.sendMessage({ type: 'SAVE_URL', url: tab.url, title: tab.title || '', note: $('note').value.trim() });
  setTimeout(() => {
    btn.disabled = false;
    btn.textContent = '保存当前页面';
    $('note').value = '';
    window.close();
  }, 600);
}

// 打开 Web 端：插件已登录时先签发一次性令牌带上（网页端立即自动登录），否则普通打开
async function openWeb() {
  const { token } = await chrome.storage.local.get('token');
  if (token) {
    try {
      const res = await fetch(`${API_BASE}/api/sso/ott`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.ott) {
        chrome.tabs.create({ url: `${WEB_ORIGIN}/?ott=${data.ott}` });
        window.close();
        return;
      }
    } catch {
      /* 签发失败时回退为普通打开 */
    }
  }
  chrome.tabs.create({ url: WEB_ORIGIN });
  window.close();
}

async function main() {
  const { token, email } = await chrome.storage.local.get(['token', 'email']);
  state.token = token || null;
  state.email = email || '';
  render();
  await restoreEmail();

  $('tab-pw').addEventListener('click', () => { state.mode = 'password'; setMsg(''); render(); });
  $('tab-code').addEventListener('click', () => { state.mode = 'code'; setMsg(''); render(); });

  // 密码模式：底部按钮直接登录；验证码模式：发送验证码在输入框右侧，底部按钮为登录
  $('btn-send').addEventListener('click', sendCode);
  $('btn-login').addEventListener('click', () => (state.mode === 'password' ? loginPassword() : verifyCode()));
  $('password').addEventListener('keydown', (e) => { if (e.key === 'Enter') loginPassword(); });
  $('code').addEventListener('keydown', (e) => { if (e.key === 'Enter') verifyCode(); });
  $('btn-save').addEventListener('click', saveCurrentPage);
  $('btn-logout').addEventListener('click', async () => {
    // 只清登录态；记住的邮箱保留，下次打开自动带出
    await chrome.storage.local.remove(['token', 'email']);
    state.token = null;
    state.email = null;
    state.mode = 'password';
    $('password').value = '';
    $('code').value = '';
    setMsg('');
    render();
    await restoreEmail();
  });

  const webLink = $('link-web');
  webLink.href = WEB_ORIGIN;
  webLink.addEventListener('click', (e) => {
    e.preventDefault();
    openWeb();
  });

  $('open-web').addEventListener('click', (e) => {
    e.preventDefault();
    openWeb();
  });
}

main();
