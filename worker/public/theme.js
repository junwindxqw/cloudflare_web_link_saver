// 在页面渲染前应用主题，避免深色用户每次加载看到白屏闪烁。
// 独立外链脚本（非内联）以兼容 CSP script-src 'self'；与 app.js 的主题切换共用同一存储键。
'use strict';
(function () {
  try {
    var saved = localStorage.getItem('ls_theme');
    var dark = saved ? saved === 'dark' : window.matchMedia('(prefers-color-scheme: dark)').matches;
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  } catch (e) { /* 隐私模式等场景忽略，回退默认亮色 */ }
})();
