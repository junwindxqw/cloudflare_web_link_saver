import { API_BASE, WEB_ORIGIN } from './config.js';

const MENU_SAVE = 'ls-save';
const MENU_SAVE_SELECTION = 'ls-save-selection';
const MENU_SAVE_IMAGE = 'ls-save-image';
const MENU_OPEN = 'ls-open';
const MAX_TEXT_CHARS = 10000;

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: MENU_SAVE, title: 'Send to Link Saver', contexts: ['page', 'link'] });
    chrome.contextMenus.create({ id: MENU_SAVE_SELECTION, title: '保存选中文本到 Link Saver', contexts: ['selection'] });
    chrome.contextMenus.create({ id: MENU_SAVE_IMAGE, title: '保存图片到 Link Saver', contexts: ['image'] });
    chrome.contextMenus.create({ id: MENU_OPEN, title: 'Open Link Saver Web', contexts: ['page'] });
  });
});

async function getAuth() {
  const { token } = await chrome.storage.local.get('token');
  return token || null;
}

function flashBadge(text, color) {
  chrome.action.setBadgeBackgroundColor({ color });
  chrome.action.setBadgeText({ text });
  setTimeout(() => chrome.action.setBadgeText({ text: '' }), 2500);
}

function notify(message) {
  chrome.notifications.create({
    type: 'basic',
    iconUrl: 'icons/icon128.png',
    title: 'Link Saver',
    message,
  });
}

// 带 token 的保存请求：登录态 / 网络错误统一反馈，失败返回 null
async function postAuthJson(path, payload) {
  const token = await getAuth();
  if (!token) {
    flashBadge('!', '#dc2626');
    notify('请先在工具栏 Link Saver 图标中登录');
    return null;
  }
  try {
    const res = await fetch(`${API_BASE}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(payload),
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401) {
      await chrome.storage.local.remove('token');
      flashBadge('!', '#dc2626');
      notify('登录已过期，请重新登录');
      return null;
    }
    if (!res.ok) throw new Error(data.error || `保存失败(${res.status})`);
    return data;
  } catch (e) {
    flashBadge('!', '#dc2626');
    notify(e.message || '保存失败，请检查网络');
    return null;
  }
}

async function saveUrl(url, title) {
  if (!url || !/^https?:\/\//i.test(url)) {
    flashBadge('!', '#dc2626');
    notify('仅支持保存 http/https 网址');
    return;
  }
  const data = await postAuthJson('/api/links', { url, title: title || '' });
  if (!data) return;
  flashBadge('✓', '#16a34a');
  notify(data.existed ? `已更新收藏（${data.category}）` : `已保存到「${data.category}」`);
}

async function saveSelection(text, pageUrl, pageTitle) {
  const content = (text || '').trim();
  if (!content) {
    flashBadge('!', '#dc2626');
    notify('没有可保存的选中文本');
    return;
  }
  const data = await postAuthJson('/api/snippets', {
    type: 'text',
    content: content.slice(0, MAX_TEXT_CHARS),
    source_url: pageUrl || '',
    source_title: pageTitle || '',
  });
  if (!data) return;
  flashBadge('✓', '#16a34a');
  notify(`已保存短文本（${Math.min(content.length, MAX_TEXT_CHARS)} 字）`);
}

async function saveImage(srcUrl, pageUrl, pageTitle) {
  if (!srcUrl || /^(blob|file):/i.test(srcUrl)) {
    flashBadge('!', '#dc2626');
    notify('不支持保存该类型的图片地址');
    return;
  }
  const data = await postAuthJson('/api/snippets', {
    type: 'image',
    content: srcUrl,
    source_url: pageUrl || '',
    source_title: pageTitle || '',
  });
  if (!data) return;
  flashBadge('✓', '#16a34a');
  notify(data.stored ? '图片已转存到服务端' : '已保存图片链接（转存失败，保留原始地址）');
}

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId === MENU_OPEN) {
    chrome.tabs.create({ url: WEB_ORIGIN });
    return;
  }
  if (info.menuItemId === MENU_SAVE_SELECTION) {
    await saveSelection(info.selectionText, info.pageUrl || tab?.url || '', tab?.title || '');
    return;
  }
  if (info.menuItemId === MENU_SAVE_IMAGE) {
    await saveImage(info.srcUrl, info.pageUrl || tab?.url || '', tab?.title || '');
    return;
  }
  if (info.menuItemId !== MENU_SAVE) return;

  const url = info.linkUrl || info.pageUrl || tab?.url || '';
  let title = tab?.title || '';
  if (info.linkUrl && tab?.id != null) {
    // 尽力取链接文字作为标题（activeTab 已随右键点击授权）
    try {
      const [injection] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: (href) => {
          const a = [...document.querySelectorAll('a[href]')].find((x) => x.href === href);
          return a ? (a.innerText || a.title || '').trim().slice(0, 200) : '';
        },
        args: [info.linkUrl],
      });
      if (injection?.result) title = injection.result;
    } catch {
      // 取不到链接文字时由服务端从 URL / 页面推断
    }
  }
  await saveUrl(url, title);
});

// 弹窗请求：直接复用保存逻辑与角标反馈
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === 'SAVE_URL') {
    saveUrl(msg.url, msg.title).finally(() => sendResponse({ ok: true }));
    return true;
  }
  return undefined;
});

// Web 端自动登录：页面凭扩展签发的一次性令牌换取正式凭证
chrome.runtime.onMessageExternal.addListener((msg, sender, sendResponse) => {
  if (sender.origin !== WEB_ORIGIN) return undefined;
  if (msg?.type !== 'LINK_SAVER_GET_OTT') return undefined;

  (async () => {
    const token = await getAuth();
    if (!token) return sendResponse({ ok: false, reason: 'not_logged_in' });
    try {
      const res = await fetch(`${API_BASE}/api/sso/ott`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.ott) sendResponse({ ok: true, ott: data.ott });
      else sendResponse({ ok: false, reason: res.status === 401 ? 'not_logged_in' : 'error' });
    } catch {
      sendResponse({ ok: false, reason: 'error' });
    }
  })();
  return true; // 异步响应
});
