import { API_BASE, WEB_ORIGIN } from './config.js';

const $ = (id) => document.getElementById(id);
const state = { token: null, email: null, mode: 'password', stage: 'email' };

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
  $('email').readOnly = isCode && state.stage === 'code';
  $('btn-login').textContent = isCode
    ? (state.stage === 'email' ? '发送验证码' : '登录')
    : '登录';
}

async function loginPassword() {
  const email = $('email').value.trim();
  const password = $('password').value;
  if (!email || !password) return setMsg('请输入邮箱和密码');
  setMsg('正在登录…', true);
  try {
    const data = await postJson('/api/auth/login', { email, password });
    state.token = data.token;
    state.email = data.email;
    await chrome.storage.local.set({ token: data.token, email: data.email });
    setMsg('');
    render();
  } catch (e) {
    setMsg(e.message);
  }
}

async function sendCode() {
  const email = $('email').value.trim();
  if (!email) return setMsg('请输入邮箱地址');
  setMsg('正在发送验证码…', true);
  try {
    const data = await postJson('/api/auth/request-code', { email });
    setMsg(data.message || '验证码已发送', true);
    state.stage = 'code';
    render();
    $('code').focus();
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
  await chrome.runtime.sendMessage({ type: 'SAVE_URL', url: tab.url, title: tab.title || '' });
  setTimeout(() => window.close(), 600);
}

async function main() {
  const { token, email } = await chrome.storage.local.get(['token', 'email']);
  state.token = token || null;
  state.email = email || '';
  render();

  $('tab-pw').addEventListener('click', () => { state.mode = 'password'; state.stage = 'email'; setMsg(''); render(); });
  $('tab-code').addEventListener('click', () => { state.mode = 'code'; state.stage = 'email'; setMsg(''); render(); });

  $('btn-login').addEventListener('click', () => {
    if (state.mode === 'password') return loginPassword();
    return state.stage === 'email' ? sendCode() : verifyCode();
  });
  $('password').addEventListener('keydown', (e) => { if (e.key === 'Enter') loginPassword(); });
  $('email').addEventListener('keydown', (e) => { if (e.key === 'Enter') (state.mode === 'password' ? $('password') : state.stage === 'email' ? $('code') : $('code')).focus(); });
  $('code').addEventListener('keydown', (e) => { if (e.key === 'Enter') verifyCode(); });
  $('btn-save').addEventListener('click', saveCurrentPage);
  $('btn-logout').addEventListener('click', async () => {
    await chrome.storage.local.remove(['token', 'email']);
    state.token = null;
    state.email = null;
    state.mode = 'password';
    state.stage = 'email';
    $('email').value = '';
    $('password').value = '';
    $('code').value = '';
    setMsg('');
    render();
  });

  const webLink = $('link-web');
  webLink.href = WEB_ORIGIN;
  webLink.addEventListener('click', (e) => {
    e.preventDefault();
    chrome.tabs.create({ url: WEB_ORIGIN });
    window.close();
  });

  $('open-web').addEventListener('click', (e) => {
    e.preventDefault();
    chrome.tabs.create({ url: WEB_ORIGIN });
    window.close();
  });
}

main();
