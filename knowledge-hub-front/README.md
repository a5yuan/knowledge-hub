# knowledge-hub-front · 企业智能知识库前端

企业级知识库系统的 Web 前端，基于 **Vue 3 + Vite + TypeScript + Element Plus** 构建的单页应用，覆盖文档管理、在线编辑、智能搜索、数据大盘与系统管理等模块。

> **当前状态**：MVP 已完整交付（`.scratch/knowledge-hub-mvp/issues/01~13` 全部 done），并已完成与后端 `knowledge-hub-backend` 的**双通道联调**——鉴权、文档域、搜索域走真实接口，其余域保留 Mock 并显式标注，详见[与后端的对接现状](#与后端的对接现状)与 [ADR-0005](docs/adr/0005-dual-channel-backend-integration.md)。

---

## 技术栈

| 分类      | 选型                                                           | 版本             |
| --------- | -------------------------------------------------------------- | ---------------- |
| 框架      | Vue 3（Composition API，`<script setup lang="ts">`）           | ^3.5.13          |
| 构建      | Vite                                                           | ^6.1.0           |
| 语言      | TypeScript（strict + `noUnusedLocals` + `noUnusedParameters`） | ~5.7.3           |
| UI 组件库 | Element Plus（图标全局注册）                                   | ^2.9.3           |
| 状态管理  | Pinia                                                          | ^3.0.1           |
| 路由      | vue-router（history 模式）                                     | ^4.5.0           |
| HTTP      | axios                                                          | ^1.20.0          |
| 富文本    | TipTap（starter-kit + image + table）                          | ^2.27.3          |
| 图表      | ECharts（按需 `echarts.use([...])` 摇树）                      | ^6.1.0           |
| 接口 Mock | MSW（Service Worker 拦截）                                     | ^2.15.0          |
| 代码规范  | ESLint 9（flat config）+ Prettier                              | ^9.20.0 / ^3.5.0 |
| 包管理    | pnpm                                                           | —                |

**样式方案**：原生 scoped CSS + 一份全局 `src/styles/index.css`，无 Tailwind / Sass / UnoCSS。通过覆盖 Element Plus 的 CSS 变量定制主题（主色 `--el-color-primary: #1a66ff`）。

**界面语言**：仅中文（`index.html` 的 `lang="zh-CN"`，标题「企业智能知识库系统」），未接入 i18n。

---

## 快速开始

```bash
pnpm install
pnpm dev        # 开发服务器 http://localhost:5173（Mock 默认开启）
```

打开后用演示账号登录（见下方[演示账号](#演示账号)）即可浏览全部功能。

### 可用命令

| 命令           | 说明                                              |
| -------------- | ------------------------------------------------- |
| `pnpm dev`     | 启动开发服务器（Vite，端口 5173）                 |
| `pnpm build`   | 类型检查 + 生产构建（`vue-tsc -b && vite build`） |
| `pnpm preview` | 预览生产构建产物                                  |
| `pnpm lint`    | ESLint 检查                                       |
| `pnpm format`  | Prettier 格式化                                   |

> 项目**没有测试脚本，也没有安装测试框架**（`msw` 仅作为开发期 Mock 服务器使用）。

---

## 目录结构

```
src/
├── api/                  # 接口层：每个资源一个模块，共 12 个 + http.ts
│   ├── http.ts           # axios 实例、拦截器、request<T>() 统一拆包
│   ├── auth.ts           # 登录 / 当前用户 / 改资料 / 改密码
│   ├── documents.ts      # 文档 CRUD / 上传 / 批量操作
│   ├── folders.ts        # 目录树
│   ├── search.ts         # 搜索 / 热搜
│   ├── stats.ts          # 大盘统计 / 我的统计
│   ├── users.ts          # 用户管理
│   ├── departments.ts / categories.ts / tags.ts
│   └── announcements.ts / operations.ts
├── components/
│   ├── charts/VChart.vue     # ECharts 通用包装
│   └── editor/               # RichEditor.vue（TipTap 包装）、json.ts（EditorJSON 类型）
├── layouts/
│   └── MainLayout.vue        # 顶栏 + 横向菜单外壳
├── mocks/                    # MSW Mock 后端
│   ├── browser.ts            # worker 启动
│   ├── db.ts                 # 模块级内存数据库 + 权限/筛选纯函数
│   ├── seed.ts               # 演示数据种子
│   ├── parse.ts              # 模拟文档解析状态流转
│   └── handlers/             # auth / documents / folders / search / stats / admin / utils
├── router/index.ts       # 路由表 + 全局前置守卫
├── stores/user.ts        # 唯一 Pinia store
├── styles/index.css      # 全局样式 + Element Plus 变量覆盖
├── types/api.ts          # 完整领域类型契约
├── views/                # 页面
├── App.vue / main.ts / vite-env.d.ts
```

---

## 路由与页面

路由使用 `createWebHistory(import.meta.env.BASE_URL)`，所有业务页面懒加载并渲染在 `MainLayout` 内（登录页独立布局）。

| 路径                     | 名称             | 功能                  | 备注                                                                  |
| ------------------------ | ---------------- | --------------------- | --------------------------------------------------------------------- |
| `/login`                 | login            | 登录                  | `meta.public: true`                                                   |
| `/`                      | —                | 重定向至 `/dashboard` |                                                                       |
| `/dashboard`             | dashboard        | 首页大盘              | 统计卡片 + 趋势折线 + 分类环形 + 最近操作                             |
| `/documents`             | documents        | 文档管理（核心页）    | 四分区 + 目录树 + 列表/卡片切换                                       |
| `/documents/:id/edit`    | document-editor  | 在线文档编辑          | 仅 `type=online`                                                      |
| `/documents/:id/preview` | document-preview | 文档预览 / 下载       |                                                                       |
| `/documents/reviews`     | document-reviews | 审核工作台            | `meta.requiresReviewer: true`（工单 03 新增，仅 reviewer/admin 可见） |
| `/search`                | search           | 智能搜索              | 高亮、热搜、历史、高级筛选                                            |
| `/ai-qa`                 | ai-qa            | AI 智能问答           | **二期占位页**                                                        |
| `/knowledge-graph`       | knowledge-graph  | 知识图谱              | **二期占位页**                                                        |
| `/profile`               | profile          | 个人中心              |                                                                       |
| `/admin`                 | admin            | 系统管理 - 用户管理   | `meta.requiresAdmin: true`                                            |

### 全局路由守卫

`router.beforeEach` 的执行顺序：

1. 有 Token 但 store 为空 → 先 `userStore.restoreSession()` 恢复会话
2. 已登录访问 `public` 页面 → 重定向到 `/dashboard`
3. 未登录且访问非 `public` 页面 → 跳 `/login?redirect=<fullPath>`
4. `requiresAdmin` 不满足 → `ElMessage.warning('该页面仅管理员可访问')` 并退回 `/dashboard`

登录页处理 `redirect` 参数时**只接受同站路径**（`startsWith('/')`），防止开放重定向。

---

## 状态管理

Pinia，但**只有一个 store**：`src/stores/user.ts`（setup 风格）。

- **状态**：`user: PublicUser | null`
- **派生**：`isLoggedIn`、`isAdmin`（`role === 'admin'`）、`roleLabel`
- **动作**：
  - `login(username, password)` — 调接口、存 Token、写 user
  - `restoreSession()` — 用**单飞 Promise**（`restoring ??= ...`）避免并发守卫重复请求 `/auth/me`，失败时清理凭证
  - `logout()` / `setUser()`（资料修改后同步顶栏）

**Token 不放在 store 里**，由 `src/api/session.ts` 统一管理**四个会话键**：`kh_token`（access token）、`kh_refresh_token`、`kh_token_exp`、`kh_mock_token`（Mock 通道专用），外加版本闸 `kh_session_v`（不匹配即整体失效）。

---

## 请求层

`src/api/http.ts` 是唯一的请求出口，axios 实例默认 `baseURL: '/api'`（Mock 保留地）；真实请求由 `endpoint()` 显式覆盖为 `/real`（见[与后端的对接现状](#与后端的对接现状)）：

```ts
axios.create({ baseURL: '/api', timeout: 15000 })
```

- **请求拦截器**：按通道选 token —— `/real` 用 access token，`/api` 用 mock token（会话桥签发，回落 kh_token）
- **响应拦截器**：只负责「401 → 单飞刷新（`src/api/refresh.ts`，并发共享同一 inflight）→ 重放一次（`_skipAuthRefresh` 标记防循环）」；刷新失败清空四个会话键与内存用户态并跳 `/login?redirect=...`
- **`request<T>(config)`**：按通道分流至 `normalizeResponse`（拆包 + HTML 守卫），业务错误统一抛 `ApiError`（正数 code = Mock 业务码，负数 = -HTTP 状态码）

> 代理：`vite.config.ts` 的 `realProxy` 把 `/real` → `http://127.0.0.1:3000`、`/storage` → `http://127.0.0.1:9000`（RustFS 对象存储），rewrite 剥前缀；`/api` 永不配代理（MSW 保留地）。server 与 preview 成对配置。

---

## Mock 策略（MSW）

这是本项目一个刻意的工程决策（见 [ADR-0003](docs/adr/0003-mock-first-api-isolation.md)）：**组件只依赖 `src/api/`，MSW 在 Service Worker 层拦截全部 REST 端点**，使前端可以在后端就绪前独立完成全部功能与走查。

### 工作机制

- **开启条件**：`VITE_ENABLE_MOCK !== 'false' && (DEV || VITE_ENABLE_MOCK === 'true')`，即开发环境默认开启；生产构建默认不启动（可显式 `VITE_ENABLE_MOCK=true` 打开做演示）。
- **启动时机**：`main.ts` 中 **`initSession()`（会话键版本闸）最先执行**，`await worker.start()` 早于 `app.use(router)`，避免首个路由守卫发出的 `/auth/me` 被绕过。
- `onUnhandledRequest` 为函数：`/real` 与 `/storage` 直接放行到真实网络，其余未匹配请求（应为 `/api`）打印告警——双通道下放行是常态，告警用于发现漏配 handler。
- 所有 handler 在 `handlers/utils.ts` 中通过 `ok()` / `fail()` / `forbidden()` / `unauthorized()` 返回统一信封，并注入 `120 + rand*180 ms` 的模拟延迟。

### 内存数据库

`src/mocks/db.ts` 是一个模块级单例，权限与筛选逻辑全部实现为**纯函数**（便于后续迁移到真实后端时对照，也便于补单元测试）：

| 函数                                                           | 职责                                                                                                               |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `canSeeDocument`                                               | 可见性：admin 全见；owner 见自己的；`company` 全员可见；`department` 需同部门。**不可见即完全隐藏，而非置灰**      |
| `canManageDocument`                                            | admin 或 owner 可管理                                                                                              |
| `inZone`                                                       | 分区判定：归档 = `archivedAt != null`；我的 = owner 为本人；公开 = `visibility === 'company'`；部门 = owner 同部门 |
| `filterDocuments`                                              | 权限 → 分区 → 字段筛选 → 关键词（title + summary + owner 名）→ 排序                                                |
| `paginate`                                                     | 分页，`pageSize` 钳制在 1..100                                                                                     |
| `relevanceScore`                                               | 相关性打分：title 3 > tag 2 > summary 1                                                                            |
| `toSearchResult` / `logOperation` / `todayNewCount` / `nextId` | 结果组装、操作日志、统计、ID 生成                                                                                  |

`src/mocks/parse.ts` 模拟文档解析流程：`pending → processing（2-4 秒）→ 90% done / 10% failed`，用于驱动文档列表的解析状态轮询。

### 演示账号

| 账号    | 密码     | 角色              | 部门   |
| ------- | -------- | ----------------- | ------ |
| `admin` | `123456` | admin（张管理员） | 研发部 |
| `li`    | `123456` | 成员              | 研发部 |
| `qian`  | `123456` | 成员              | 研发部 |
| `wang`  | `123456` | 成员              | 产品部 |

内置部门：研发部 / 产品部 / 市场部。Mock Token 形如 `mock_<userId>_<ts>`，由 `getViewer()` 解析以模拟无状态 JWT。

> 后端 seed 账号与 Mock 凭据相同（`admin/123456` 等），登录统一走 `/real/auth/login`；同名账号在两侧各有一份用户数据，由**会话桥**（`src/mocks/identity.ts`）镜像打通——真实登录用户会被签发 Mock token，使 `/api` 端点组在真实登录态下可用。

### 通道切换与逃生舱

联调采用**双通道混合模式**（[ADR-0005](docs/adr/0005-dual-channel-backend-integration.md)）：Mock 无需关闭，`/api` 与 `/real` 并存。通道决策点在 `src/api/endpoint.ts` 的 `DEFAULT_MODE` 资源模式表；运维逃生舱支持单资源临时回退 Mock：

```js
// DevTools Console：文档域临时回退 Mock（刷新后生效），用于后端故障时保住演示
localStorage.setItem('kh_api_mode', JSON.stringify({ documents: 'mock' }))
localStorage.removeItem('kh_api_mode')   // 恢复真实通道
```

---

## 功能说明

### 文档管理（`views/documents/Index.vue`，核心页）

> 真实模式下的分区/目录/排序/批量等降级见[对接现状降级总表](#真实模式降级总表spec-§44)。

- **四分区**：我的 / 公开 / 部门 / 归档（`ZONES` 常量）
- **目录树**：`el-tree`，由扁平列表经 `buildFolderTree` 构建，根节点为「全部文档」，支持新建目录
- **工具栏**：300ms 防抖关键词搜索、上传、新建目录、筛选（文件类型 / 解析状态 / 可见性）、列表⇄卡片切换、刷新
- **表格**：按 createdAt/updatedAt 排序；文件类型徽标按扩展名着色、解析状态标签、可见性标签、上传人
- **操作**：行内与批量（批量删除 / 归档 / 恢复 / 移动）；`canManage(ownerId)` = admin 或 owner
- **解析状态轮询**：存在 pending/processing 行时每 **2 秒**轮询（`syncParsePolling`），组件卸载时清除
- **删除末行自动回退上一页**

配套弹窗组件：`UploadDialog.vue`（上传）、`MetaDialog.vue`（新建/编辑在线文档元信息）、`MoveDialog.vue`（移动）、`DocMetaFields.vue`（分类/标签/可见性/目录公共字段）。

### 在线编辑（`views/documents/Editor.vue`）

仅对 `type=online` 的文档开放，使用 TipTap 富文本编辑：

- **1.5 秒防抖自动保存**，`saved` / `dirty` / `saving` 三态提示
- 保存请求合并，失败自动重试
- 页面关闭兜底：`beforeunload` 中用 `fetch(..., { keepalive: true })` 携带 Token 提交
- 路由离开：`onBeforeRouteLeave` 等待在途保存完成

### 预览与下载（`views/documents/Preview.vue`）

正文区由**解析状态 + 正文**驱动（[ADR-0006](docs/adr/0006-markdown-content-rendering.md)），不是由文件类型驱动：

- **解析完成（`done` 且正文非空）**：markdown 渲染，正文取自 `DocumentDetail.content`（后端 Mongo 的解析产物）。PDF 另提供「查看 PDF 原文」切换
- **解析中（`pending` / `processing`）**：按原格式展示 + 状态条 + **有界轮询**（40 × 2.5s ≈ 100s，完成后自动切到 markdown）。超时停止刷新并给「重新检查」——后端 `processParse` 无超时无重试，可能永久停在 `running`
- **解析失败（`failed`）**：原格式 + 错误横幅展示 `parseError` 原文
- **原格式视图**：PDF 走原生 `iframe` + blob URL（iframe 首次导航不受 Service Worker 控制，必须先转 blob；**校验 `res.ok` 与 `Content-Type`**，403/404 或 SPA fallback 返回 HTML 时给出明确报错而非空白 iframe）；txt / md 按原文展示；office（docx/xlsx/pptx）与未知格式显示「下载查看」空状态——浏览器无原生渲染能力，解析完成后才可在线阅读
- **在线文档**：复用 `RichEditor` 并传 `:editable="false"` 只读渲染（`type=online` 的 TipTap JSON，Mock 通道）
- **下载**：blob URL + 合成 `<a download>` 点击，文件名取原始文件名（`fileName`，真实通道的 `title` 已被后端去掉扩展名）

### 智能搜索（`views/search/Index.vue`）

大搜索框 + 可折叠高级筛选（文件类型 / 分类 / 可见性 / 日期范围），列表⇄卡片视图，关键词高亮（`components/HighlightText.vue`，按关键词切分文本），分类面包屑、权限标签、热门搜索（`GET /search/hot`）。

搜索历史存在 **`localStorage` 的 `kh_search_history`**，最多 20 条，去重且最近优先。

### 首页大盘（`views/dashboard/Index.vue`）

4 张统计卡片（文档总数 / 今日新增 / 用户搜索次数 / 活跃用户数）+ ECharts 平滑面积折线图（今日 / 近 7 日 / 近 30 日切换）+ 分类占比环形图（图例含数量与百分比，中心显示总数）+ 最近操作表格（动作标签按 upload/update/delete/login/ai-ask 着色）。

> 按 [ADR-0004](docs/adr/0004-ai-graph-phase-2-with-parse-status.md)，一期**刻意不放 AI 问答卡片**。

### 系统管理（`views/admin/Index.vue`）

用户列表（关键词 / 角色 / 部门 / 状态筛选 + 分页）、新建用户、编辑角色与部门、重置密码（默认 `123456`）、启用/禁用、删除。服务端守卫：不能删除自己、不能删除最后一个管理员。

> 后端无用户管理接口，本页数据恒为 Mock（页面标题旁标注「演示数据」，见工单 05）。

### 个人中心（`views/profile/Index.vue`）

可编辑显示名（同步 store → 顶栏）、只读的用户名/部门/角色、我的统计（Mock 走 `GET /stats/mine`；真实模式后端无统计接口，文档数取真实列表 total、存储占用隐藏）、修改密码（校验旧密码、最小长度 6、新旧不能相同，钉在 Mock 通道）。

### 二期占位页

`/ai-qa` 与 `/knowledge-graph` 是**纯占位页**——保留导航入口，展示「功能建设中 / 二期上线」卡片并列出规划能力，提供返回文档管理的按钮。按 spec §5.6，**刻意不做假的置灰交互**。

---

## 类型契约

`src/types/api.ts` 定义了完整的领域类型，是前后端对接时的参考基底，主要包括：

- 用户：`PublicUser`、`UserRole`（`admin` / `member`）
- 文档：`Document`、`DocVisibility`（`private` / `company` / `department`）、`ParseStatus`（`pending` / `processing` / `done` / `failed`）、`DocumentType`（`file` / `online`）
- 目录：`Folder`、`Zone`（`mine` / `public` / `department` / `archive`）
- 搜索：`SearchResult`、`SearchParams`
- 统计：`DashboardStats`、`MyStats`

> 数据模型的**唯一事实来源**是 [`.scratch/knowledge-hub-mvp/spec.md`](.scratch/knowledge-hub-mvp/spec.md) §6。后端实现必须与之对齐，出现冲突需显式修订 spec，不允许静默偏离（ADR-0003）。

---

## 环境变量

**项目仓库内不存在任何 `.env` / `.env.development` / `.env.production` 文件**（`.gitignore` 仅忽略 `*.local`）。代码中实际消费的变量只有三个：

| 变量               | 来源      | 用途                                                                              |
| ------------------ | --------- | --------------------------------------------------------------------------------- |
| `VITE_ENABLE_MOCK` | 自定义    | 值为 `'false'` 时不启动 MSW（切换真实后端的开关）。未设置时开发环境 Mock 默认开启 |
| `DEV`              | Vite 内置 | 门控 Mock 仅在开发环境启动                                                        |
| `BASE_URL`         | Vite 内置 | 路由 history 的 base                                                              |

---

## 与后端的对接现状

**双通道混合模式已落地（工单 01~05，见 [ADR-0005](docs/adr/0005-dual-channel-backend-integration.md)）**：`/api`（MSW Mock，永不配代理）与 `/real`（Vite 代理 → `http://127.0.0.1:3000`）并存。两类接口形态差异（无响应包装、snake_case、路径单复数、双 Token）全部消化在 `src/api/` 内，视图层签名零改动。

### 通道分配（`src/api/endpoint.ts` 的 `DEFAULT_MODE`）

| 资源                                                                             | 通道     | 说明                                                                                         |
| -------------------------------------------------------------------------------- | -------- | -------------------------------------------------------------------------------------------- |
| `auth`                                                                           | **real** | 登录 / 当前用户 / 单飞刷新；`updateProfile` / `changePassword` 后端无接口，钉在 Mock         |
| `documents`                                                                      | **real** | 列表 / 上传 / 审核 / 归档；正文写入、目录树（folders）、restore、批量归档后端缺失 → 见降级表 |
| `search`                                                                         | **real** | ES 关键词检索（仅 q/page/pageSize）；热搜 `fetchHotSearch` 钉在 Mock                         |
| 其余（stats/users/departments/categories/tags/folders/announcements/operations） | mock     | 后端无对应接口，页面显式标注「演示数据」                                                     |

### 关键机制

- **字段映射**：后端 snake_case 字段只允许出现在 `src/api/adapters/`（auth/document/search 三个 adapter），DTO → 领域类型（`types/api.ts`）翻译完成后，API 模块与视图层零感知
- **会话桥**：`src/mocks/identity.ts` 把真实登录用户镜像进 Mock 内存库并签发 `mock_<userId>_<ts>` token，调用点在 `stores/user.ts` 的 `login()` 与 `restoreSession()` 之后（动态 import 保持懒加载）
- **单飞刷新**：`src/api/refresh.ts` 独立裸 axios 实例（无拦截器，天然无递归），并发 401 共享同一 inflight；http.ts 拦截器负责「401 → 刷新 → 重放一次」，失败清四个会话键 + 内存用户态并跳登录
- **有损映射显式降级**：后端不可能提供的字段不做占位误导，UI 显示「—」或隐藏并说明

### 真实模式降级总表（spec §4.4）

| 能力                     | 现状                                                     | 位置                                                         |
| ------------------------ | -------------------------------------------------------- | ------------------------------------------------------------ |
| 在线文档正文编辑         | **只读**，仅标题可保存（后端无正文写入接口）             | `views/documents/Editor.vue`                                 |
| 目录树 / 文件夹          | 空态说明「后端暂未提供文件夹接口」                       | `views/documents/Index.vue`                                  |
| 部门分区 / 部门可见      | 分区隐藏；「部门可见」选项隐藏，写入降级 private/company | `views/documents/Index.vue` / `components/DocMetaFields.vue` |
| 上传人 / 文件类型 / 大小 | 显示「—」或「文档」徽标（列表响应无该字段）              | `views/documents/Index.vue`                                  |
| 列表的解析状态           | 仅近期上传行显示（列表响应无 `parse_state`，靠并发拉详情合并；详情页始终准确） | `src/api/adapters/document.ts` / `views/documents/Preview.vue` |
| 表头排序                 | 禁用（后端固定 `created_at DESC`）                       | `views/documents/Index.vue`                                  |
| 归档恢复 / 批量归档      | 禁用并警告（无 restore 接口，归档为终态）                | `views/documents/Index.vue`                                  |
| 搜索高级筛选             | 禁用并标注（后端仅支持关键词）                           | `views/search/Index.vue`                                     |
| 个人中心存储占用         | 隐藏；文档数改用真实列表 total                           | `views/profile/Index.vue`                                    |
| 首页大盘 / 系统管理      | 整页 Mock + 标注「演示数据」                             | `views/dashboard` / `views/admin`                            |

### 后端前置条件与遗留项

- **审核流需 `REVIEW_ENABLED=true`**（`.env`，不入库）：关闭时发布直接生效、不产生待审记录，审核工作台显示对应说明
- **RustFS 桶需开匿名读**（`s3:GetObject`），否则 `/storage` 预览/下载 403
- 其余待后端项（is_public 转换缺陷、软删待审行、ACL 缺口、字段补齐等）已整理为 [backend-integration/backend-todo.md](../backend-integration/backend-todo.md)，可独立转交后端

---

## 项目治理

本项目使用一套本地文档驱动的开发流程：

- **[`CLAUDE.md`](CLAUDE.md)** —— 定义 agent 协作约定（issue 跟踪位置、领域文档位置、可用 skills）
- **[`docs/adr/`](docs/adr/)** —— 架构决策记录（ADR）：
  - [0001](docs/adr/0001-vue3-element-plus-tech-stack.md) 选择 Vue 3 + Element Plus 技术栈（否决 Naive UI / Arco / Ant Design Vue / React）
  - [0002](docs/adr/0002-hybrid-content-model.md) 混合内容模型：以文件上传为主，`type=online` 的 TipTap 文档为其中一个分支；正文以 JSON 而非 HTML 存储，便于携入二期 AI 抽取
  - [0003](docs/adr/0003-mock-first-api-isolation.md) Mock 优先与接口隔离（见上文）
  - [0004](docs/adr/0004-ai-graph-phase-2-with-parse-status.md) AI 问答与知识图谱延后至二期，但 `parseStatus` 一期先落地作为解析管线入口
  - [0005](docs/adr/0005-dual-channel-backend-integration.md) 双通道混合模式：`/api` Mock 保留地 + `/real` 真实后端；snake_case 只允许出现在 `src/api/adapters/` 的红线；混合模式的适用边界
  - [0006](docs/adr/0006-markdown-content-rendering.md) 真实后端正文格式为 markdown，前端以 markdown-it + DOMPurify 渲染（`html: false`）；三层安全姿态；预览页状态机；部分取代 MVP spec §10 决议 #3 的 office 仅下载结论
- **[`docs/agents/`](docs/agents/)** —— `domain.md`（领域建模约定）、`issue-tracker.md`（本地 markdown issue 跟踪规范）
- **[`.scratch/knowledge-hub-mvp/`](.scratch/knowledge-hub-mvp/)** —— MVP 规格与工单：
  - `spec.md` —— 需求规格（§6 数据模型、§7 REST 契约，**唯一事实来源**）
  - `issues/01~13` —— 项目脚手架、API+Mock 基座、鉴权与守卫、文档浏览、文档操作、TipTap 编辑、预览下载、智能搜索、大盘、二期占位、用户管理、个人中心、演示打磨与验收（全部 `Status: done`）
- **`.claude/skills/`** —— 通过 `skills-lock.json` 从远端锁定（含内容哈希）的 skills：`domain-modeling`、`grilling`、`tdd`

---

## 已知限制

- **AI 问答与知识图谱为占位页**，二期实现
- **无 SSE / WebSocket / 流式能力**，无对话客户端
- **markdown 渲染无代码高亮**：`markdown-it` 只做解析，围栏代码块是自建外壳（等宽字体 + 浅底色 + 复制按钮），不接 highlight.js / shiki
- **无 i18n**，中文字符串硬编码
- **无暗色主题 / 主题切换**，仅覆盖了主色
- **无测试框架与测试用例**
- **office 文档在解析完成前只能下载**：docx / xlsx / pptx 浏览器无原生渲染能力，后端也无 office→HTML 接口；解析完成后可在线阅读 markdown，二期若接 kkFileView 一类服务只需替换原格式分支（[ADR-0006](docs/adr/0006-markdown-content-rendering.md)）
- **markdown 正文里的图片会裂图**：MinerU 产出的是带保留期的原始外链，后端从不把图片搬到 RustFS；前端只能替换为「图片不可用」占位
- 通知铃铛的红点数量在 Mock 下为演示值 `3`，真实模式下每 30 秒轮询 `pendingReviewCount`（页面不可见时暂停）

---

## 相关文档

- 仓库根 [`README.md`](../README.md) —— 前后端整体架构与后端说明
- 后端 [`knowledge-hub-backend/README.md`](../knowledge-hub-backend/README.md)
