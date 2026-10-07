# Link Saver

一个托管在 Cloudflare 免费服务上的网页收藏系统：Chrome 扩展一键收藏 + 响应式 Web 收藏夹 + 邮箱验证码登录。

## 功能

- **Web 端手动添加**：顶栏「＋ 添加」支持手动输入网址（可带备注和标题，自动分类）、
  手动录入纯文本（上限 1 万字）、粘贴/拖拽/选择图片（≤5MB，自动转存 R2）

- **Chrome 扩展（MV3）**
  - 右键菜单唯一入口 **Send to Link Saver**：按右键对象智能保存——页面/链接存为收藏、
    选中文本存为纯文本（上限 1 万字）、图片由服务端抓取并转存到 R2 对象存储（≤5MB，
    按内容哈希去重；转存失败时回退保存原始图片链接）
  - 工具栏弹窗：邮箱验证码登录、保存当前页面（可填备注名称）、打开 Web 端
  - 保存链接时可填写**备注名称**（如「待读」「设计参考」）：同一网址重复保存时保留已备注；
    Web 端在列表中以标签展示备注、支持点击就地编辑（留空即清除），搜索框支持按备注筛选
  - 保存结果通过图标角标（✓ / !）与系统通知反馈
- **自动分类**
  - 纯域名（如 `https://github.com/`）或 Web 应用入口页（`/chat`、`/home` 等单段入口词）→ 存为 **网站**，自动以域名创建分类
  - 确认是内容页的（多段路径、`.html`/`.php` 等静态文章后缀、含长数字 ID 的路径）→ 存为 **文章**，归入「文章」分类，并自动补全所属站点的网站记录（含域名）
  - 文章按月份归档；保存时先入库兜底标题，服务端随后在后台抓取页面 `<title>` 自动回填（不阻塞保存请求）
  - 保存时自动归一网址：剥离锚点与常见追踪参数（`utm_*`、`fbclid` 等）、去除路径尾部斜杠、
    参数按名称排序、`www.` 前缀与裸域视为同一网址——同一文章不会因入口不同存成多条
- **Web 端（响应式，PC / 手机）**
  - 类型筛选：全部 / 网站 / 文章 / 短文本 / 图片
  - 网站分类侧栏 + 文章月份归档 + 搜索 + 加载更多
  - 短文本 / 图片按保存时间倒序展示，支持搜索内容与来源；转存图片经鉴权接口读取，点击可放大预览
  - 支持删除收藏、点击文章条目里的域名跳转到该网站分类
- **登录与凭证打通**
  - 注册：邮箱 + 密码 + 邮箱验证码（验证所有权）；密码 PBKDF2-HMAC-SHA256 加盐存储
  - 登录：密码登录，或邮箱验证码免密登录（验证码登录对未注册邮箱自动建号）
  - 找回密码：邮箱接收重置验证码 → 设置新密码（响应一致，防账号枚举）
  - 登录后在网页端可修改/设置密码（未设置过密码的账号免旧密码直接设置，提示按钮为「设置密码」）
  - 密码登录带防爆破（同账号连续失败 10 次锁定 15 分钟）；验证码 60s 重发冷却 + 单 IP 每日限额
  - JWT 有效期 30 天
  - 扩展已登录时，打开 Web 页面通过 `externally_connectable` 消息桥自动换取凭证，**免登录**
  - 未装扩展 / 未登录时，Web 端独立使用上述任一方式登录

## 目录结构

```
├── worker/                 # Cloudflare Worker（API + 静态资源）
│   ├── src/                #   Hono 后端源码（auth / links / snippets / sso / email / url）
│   ├── public/             #   Web 前端（index.html / app.js / app.css）
│   ├── schema.sql          #   D1 数据库结构
│   └── wrangler.jsonc      #   Worker 配置
├── extension/              # Chrome 扩展（MV3）
│   ├── manifest.json       #   含固定 key（决定扩展 ID，勿随意更换）
│   ├── background.js       #   右键菜单 / 保存 / SSO 消息桥
│   └── popup.*             #   工具栏弹窗
└── scripts/                # 辅助脚本（图标生成 / 本地 e2e 测试）
```

## 技术栈与免费额度

| 组件 | 服务 | 免费额度 |
|---|---|---|
| API + Web 托管 | Cloudflare **Workers**（含静态资源） | 10 万请求/天 |
| 数据库 | Cloudflare **D1**（SQLite） | 5 GB 存储 / 500 万行读/天 |
| 一次性令牌 / 验证码 | Cloudflare **KV** | 10 万读/天 |
| 邮件 | **Resend**（免费档 3000 封/月），发件域名 `junwind.site` |

## 首次部署

前置条件：Node 18+，已 `wrangler login`，Resend 中 `junwind.site` 域名已验证。

### 1. 创建资源并回填 ID

```bash
cd worker
npm install

npx wrangler d1 create link-saver-db
# → 复制输出的 database_id，填入 worker/wrangler.jsonc

npx wrangler kv namespace create KV
# → 复制输出的 id，填入 worker/wrangler.jsonc

npm run db:init:remote        # 初始化远端 D1 表结构
```

### 2. 配置密钥与数据库迁移

```bash
npx wrangler secret put JWT_SECRET      # 随机长字符串，如 openssl rand -hex 32
npx wrangler secret put RESEND_API_KEY  # Resend 后台创建的 API Key（re_ 开头）
```

已有部署升级时需执行增量迁移（首次部署用 `db:init:remote` 即可，无需迁移）：

```bash
npx wrangler d1 execute link-saver-db --remote --file=migrations/0001_user_password.sql
npx wrangler d1 execute link-saver-db --remote --file=migrations/0002_snippets.sql
```

`MAIL_FROM` 默认为 `Link Saver <noreply@junwind.site>`，可在 `wrangler.jsonc` 的 `vars` 中修改。

### 3. 绑定域名

```bash
npx wrangler deploy
```

部署后到 Cloudflare 控制台：**Workers & Pages → link-saver → Settings → Domains & Routes → Add → Custom domain**，添加 `link-saver.junwind.site`（域名托管在 Cloudflare，DNS 会自动配置）。API 与 Web 页面同域，无需额外跨域配置。

### 4. 安装扩展

1. 打开 `chrome://extensions`，开启右上角「开发者模式」
2. 「加载已解压的扩展程序」→ 选择 `extension/` 目录
3. 点击工具栏 Link Saver 图标，用邮箱验证码登录

扩展 ID 固定为 `ojokkllejggilcghafadekmldpgcmphd`（由 `manifest.json` 的 `key` 决定；`worker/public/app.js` 中的 `EXTENSION_ID` 与之一致）。**不要更换 manifest 的 key**，否则 Web 端自动登录会失效。

## 日常开发

```bash
cd worker
npm run dev                # http://localhost:8787（本地 D1/KV 自动模拟）

npm run typecheck          # TypeScript 类型检查
node scripts/e2e-local.cjs # 本地接口 e2e 测试（需先 npm run dev；
                           # 测试用 JWT 由 scripts 内置逻辑签发，密钥取 .dev.vars）
node scripts/security-proof.cjs  # 运行时安全实证：SQL 注入载荷惰性 + CORS 白名单回显
```

本地开发扩展：把 `extension/config.js` 与 `manifest.json` 中的
`https://link-saver.junwind.site` 改为 `http://localhost:8787`（并在 `host_permissions`、`externally_connectable` 中同步加入），改回时注意还原。

## API 一览

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/auth/request-code` | 发送登录验证码（免密登录，未注册邮箱自动建号） |
| POST | `/api/auth/verify` | 验证码登录 |
| POST | `/api/auth/register/request-code` | 发送注册验证码（已注册邮箱返回 409） |
| POST | `/api/auth/register` | 注册：邮箱 + 密码 + 邮箱验证码 |
| POST | `/api/auth/login` | 密码登录（防爆破锁定） |
| POST | `/api/auth/reset/request-code` | 发送重置验证码（响应一致防枚举） |
| POST | `/api/auth/reset-password` | 重置密码并返回新凭证 |
| GET | `/api/auth/me` | 当前用户与统计 |
| POST | `/api/links` | 保存网址，服务端自动分类（重复保存则刷新时间与标题） |
| GET | `/api/links` | 列表，支持 `type` / `category` / `month` / `q` / `limit` / `offset` |
| GET | `/api/links/overview` | 网站分类 + 月份归档 + 各类型计数（含短文本/图片） |
| DELETE | `/api/links/:id` | 删除收藏 |
| POST | `/api/snippets` | 保存选中内容：`type=text`（正文 ≤1 万字）或 `type=image`（http/data URL，服务端转存） |
| GET | `/api/snippets` | 短文本 / 图片列表，按时间倒序，支持 `type` / `q` / `limit` / `offset` |
| GET | `/api/snippets/:id/image` | 读取已转存图片（仅本人；KV 未命中时 302 回退原始外链） |
| DELETE | `/api/snippets/:id` | 删除短文本 / 图片（无引用的转存文件后台清理） |
| POST | `/api/sso/ott` | 已登录扩展签发一次性令牌（120s、单次有效） |
| POST | `/api/sso/exchange` | 一次性令牌换正式 JWT（Web 自动登录用） |
| GET | `/api/health` | 健康检查 |

所有保存的 URL 强制校验 `http/https` 协议并拒绝内网/保留地址（SSRF 防护）；服务端抓取标题与转存图片时均手动跟随重定向，逐跳重新校验目标地址；图片转存限制 `image/*` 类型且不超过 5MB。

## 常见问题

- **邮件进垃圾箱**：确认 Resend 中域名 DKIM/SPF 已验证；也可把 `MAIL_FROM` 换成其它已验证的子域。
- **Web 页面没有自动登录**：确认扩展已加载且已登录；扩展 ID 与 `app.js` 的 `EXTENSION_ID` 一致；`externally_connectable` 中包含 Web 域名。自动登录失败时页面会降级为邮箱验证码登录。
- **免费额度**：Workers 免费档 10 万请求/天、D1/KV 额度见上表，个人使用完全够用；Resend 免费档每月 3000 封验证码邮件。
