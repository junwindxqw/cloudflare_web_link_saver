# Link Saver

免费自托管的网页收藏系统：Chrome 扩展右键一键收藏 + 网页版收藏夹，程序和数据都跑在你自己的 Cloudflare 免费账号上（Workers + D1 + KV + R2，验证码邮件用 Resend 免费档）。

## 一、部署（约 10 分钟）

前置条件：Node 18+、一个 Cloudflare 账号、一个 Resend 账号（免费档每月 3000 封验证码邮件）。

### 1. 创建资源

```bash
cd worker
npm install
npx wrangler login

npx wrangler d1 create link-saver-db            # 数据库
npx wrangler kv namespace create KV             # 验证码 / 一次性令牌
npx wrangler r2 bucket create link-saver-media  # 转存图片
```

把前两条命令输出的 `database_id` 和 KV `id` 填进 `worker/wrangler.jsonc` 的对应位置（R2 不用填 ID）。

### 2. 初始化数据库

```bash
npm run db:init:remote
```

### 3. 设置密钥

```bash
npx wrangler secret put JWT_SECRET      # 登录令牌密钥，任意长随机串，例：openssl rand -hex 32
npx wrangler secret put RESEND_API_KEY  # Resend 后台创建的 API Key
```

### 4. 换成你自己的域名

仓库默认配置的域名是 `link-saver.junwind.site`，请换成你自己的域名（需托管在同一个 Cloudflare 账号下），共 3 个文件：

| 文件 | 要改的位置 |
|---|---|
| `worker/wrangler.jsonc` | `routes` 里的 pattern、`vars` 里的 `WEB_ORIGIN`（发件人 `MAIL_FROM` 用的是 Resend 域名，不同就一起改） |
| `extension/config.js` | `API_BASE` 和 `WEB_ORIGIN` |
| `extension/manifest.json` | `host_permissions` 和 `externally_connectable` |

### 5. 部署

```bash
npx wrangler deploy
```

域名托管在 Cloudflare 时会自动完成配置，无需手动加 DNS。浏览器访问你的域名，出现登录页即部署成功。

> 升级已有部署时，执行 `worker/migrations/` 里还没执行过的 SQL（`wrangler d1 execute ... --file=migrations/xxx.sql`）即可；首次部署不用。

## 二、安装 Chrome 扩展

1. 地址栏打开 `chrome://extensions`，开启右上角「开发者模式」
2. 点「加载已解压的扩展程序」，选择本仓库的 `extension/` 目录
3. 点浏览器工具栏的 Link Saver 图标，输入邮箱 → 「发送验证码」→ 填验证码 → 「登录」（未注册的邮箱首次登录会自动创建账号）

> 扩展 ID 由 `manifest.json` 里的 `key` 固定，不要更换，否则网页端自动登录会失效。

## 三、使用

**右键收藏**（扩展）：在网页上右键，点 **Send to Link Saver**，按右键的对象自动处理——

- 页面空白处 / 链接：收藏该网址，自动归类为「网站」或「文章」
- 选中的文字：存为纯文本（上限 1 万字）
- 图片：转存到你的存储（≤5MB），网页端可点击放大

**工具栏弹窗**（扩展）：点扩展图标，可以保存当前页面（能填备注名称）、打开网页收藏夹。

**网页收藏夹**：访问你部署的域名即可使用，扩展已登录时自动登录、不用再输验证码——

- 顶栏「＋ 添加」：手动添加网站、文章、纯文本、图片
- 左侧按类型浏览：网站分类、文章月份归档、纯文本、图片
- 支持搜索、按备注筛选、删除，点文章里的域名可跳到对应网站分类

## 常见问题

- **收不到验证码**：先看垃圾箱；确认 Resend 里发件域名已验证（DKIM/SPF）。
- **网页端没有自动登录**：确认扩展已加载且已登录；自动登录失败时会降级为验证码登录，手动登一次即可。
