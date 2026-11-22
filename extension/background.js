import { API_BASE, WEB_ORIGIN } from './config.js';

const MENU_SAVE = 'ls-save';
const MAX_TEXT_CHARS = 10000;

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    // 唯一的右键菜单项：按右键对象智能保存（页面/链接/选中文本/图片）
    chrome.contextMenus.create({
      id: MENU_SAVE,
      title: 'Send to Link Saver',
      // frame：iframe 内右键也能保存
      contexts: ['page', 'frame', 'link', 'selection', 'image'],
    });
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

// 带 token 的保存请求：登录态 / 网络错误统一反馈
// 成功返回 { ok: true, data }，失败返回 { ok: false, message }——弹窗需要真实的保存结果
async function postAuthJson(path, payload) {
  const token = await getAuth();
  if (!token) {
    flashBadge('!', '#dc2626');
    notify('请先在工具栏 Link Saver 图标中登录');
    return { ok: false, message: '请先在工具栏 Link Saver 图标中登录' };
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
      return { ok: false, message: '登录已过期，请重新登录' };
    }
    if (!res.ok) throw new Error(data.error || `保存失败(${res.status})`);
    return { ok: true, data };
  } catch (e) {
    flashBadge('!', '#dc2626');
    notify(e.message || '保存失败，请检查网络');
    return { ok: false, message: e.message || '保存失败，请检查网络' };
  }
}

async function saveUrl(url, title, note = '') {
  if (!url || !/^https?:\/\//i.test(url)) {
    flashBadge('!', '#dc2626');
    notify('仅支持保存 http/https 网址');
    return { ok: false, message: '仅支持保存 http/https 网址' };
  }
  const r = await postAuthJson('/api/links', { url, title: title || '', note: note || '' });
  if (!r.ok) return r;
  flashBadge('✓', '#16a34a');
  notify(r.data.existed ? `已更新收藏（${r.data.category}）` : `已保存到「${r.data.category}」`);
  return { ok: true, message: r.data.existed ? '已更新收藏' : '已保存' };
}

async function saveSelection(text, pageUrl, pageTitle) {
  const content = (text || '').trim();
  if (!content) {
    flashBadge('!', '#dc2626');
    notify('没有可保存的选中文本');
    return { ok: false, message: '没有可保存的选中文本' };
  }
  const r = await postAuthJson('/api/snippets', {
    type: 'text',
    content: content.slice(0, MAX_TEXT_CHARS),
    source_url: pageUrl || '',
    source_title: pageTitle || '',
  });
  if (!r.ok) return r;
  flashBadge('✓', '#16a34a');
  notify(`已保存短文本（${Math.min(content.length, MAX_TEXT_CHARS)} 字）`);
  return { ok: true, message: '已保存短文本' };
}

async function saveImage(srcUrl, pageUrl, pageTitle) {
  if (!srcUrl || /^(blob|file):/i.test(srcUrl)) {
    flashBadge('!', '#dc2626');
    notify('不支持保存该类型的图片地址');
    return { ok: false, message: '不支持保存该类型的图片地址' };
  }
  const r = await postAuthJson('/api/snippets', {
    type: 'image',
    content: srcUrl,
    source_url: pageUrl || '',
    source_title: pageTitle || '',
  });
  if (!r.ok) return r;
  flashBadge('✓', '#16a34a');
  notify(r.data.stored ? '图片已转存到服务端' : '已保存图片链接（转存失败，保留原始地址）');
  return { ok: true, message: r.data.stored ? '图片已转存' : '已保存图片链接' };
}

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== MENU_SAVE) return;

  // 智能保存：按右键对象决定保存什么（图片 > 选中文本 > 链接/页面）
  if (info.mediaType === 'image' && info.srcUrl) {
    await saveImage(info.srcUrl, info.pageUrl || tab?.url || '', tab?.title || '');
    return;
  }
  if (info.selectionText) {
    await saveSelection(info.selectionText, info.pageUrl || tab?.url || '', tab?.title || '');
    return;
  }

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

// 弹窗请求：直接复用保存逻辑与角标反馈；回传真实保存结果，弹窗据此提示成败
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === 'SAVE_URL') {
    saveUrl(msg.url, msg.title, msg.note || '')
      .then((r) => sendResponse(r || { ok: false, message: '保存失败' }))
      .catch(() => sendResponse({ ok: false, message: '保存失败，请重试' }));
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
