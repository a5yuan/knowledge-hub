# AGENTS.md

> 本项目**给 AI 编码工具**的地图。人类读者请看 `README.md`（27 KB，结构完整）。
> 校验日期：2026-09-28（§0 工作区于 2026-10-07 复核修正）。**若发现本文件与实际不符，先把差异报告给用户，再动手。**

## 0 工作区

企业级知识库（Knowledge Hub）：NestJS 11 后端 + Vue 3 前端，RAG + 知识图谱双链路。

| 目录 | 说明 |
|---|---|
| `knowledge-hub-backend/` | 后端，`src/` 113 个 ts |
| `knowledge-hub-front/` | 前端，`src/` 78 个源文件 |
| `backend-integration/` | 跨仓库联调层（`spec.md` + `issues/`），**已被 `.gitignore` 排除、不入库** |
| `README.md` | 面向人类的总览 |

⚠️ **单仓库模式**（2026-10-13 实测确认）：**只有根目录 `.git`**，`knowledge-hub-backend/` 与 `knowledge-hub-front/` 直接纳入根仓库 `main` 分支统一管理，**不再有嵌套 repo**。提交时不要 `cd` 进子目录以为在另一个仓库 —— `git rev-parse --show-toplevel` 一律返回根目录。旧子仓库的 `.git` 已移到 `.git-backups/backend.git` / `.git-backups/front.git`（本地保留供回滚，已被 `.gitignore` 排除）。

扫描时排除：`**/node_modules/`（约 9.9 万文件）、`knowledge-hub-backend/volumes/`（916 MB 中间件数据）、`**/dist/`、`**/.run-build/`。

**行尾统一 LF**：`.gitattributes` 声明 `* text=auto eol=lf`，本机设 `core.autocrlf=input`。`*.bat` / `*.cmd` / `*.ps1` 例外保留 CRLF；媒体与 Office 文件标记为 `binary` 不做转换。

## 1 命令

包管理器 **pnpm，不是 npm**。

```bash
# 后端
cd knowledge-hub-backend
docker compose -f docker.compose.yml up -d   # 注意不是 docker-compose.yml
pnpm install && pnpm run start:dev           # http://localhost:3000
pnpm run lint && pnpm test

# 前端
cd knowledge-hub-front
pnpm install && pnpm dev                     # http://localhost:5173
pnpm build                                   # vue-tsc -b && vite build
```

- **后端**：无全局路由前缀、无响应包装、无 Swagger。测试薄（4 spec + 1 e2e 骨架），真实用例沉淀在 `test/curl/`。
- **前端**：MSW Mock 默认开启；接真实后端设 `VITE_ENABLE_MOCK=false`。演示账号 `admin` / `li` / `qian` / `wang`，密码均 `123456`。

## 2 后端模块（`src/`）

| 模块 | 职责 |
|---|---|
| `auth/` | 双 Token、全局 `JwtAuthGuard`+`RolesGuard`、`@Public`/`@Roles`/`@CurrentUser`、邮箱激活、密码重置、RBAC 权限 |
| `document/` | 文档主域：CRUD + 上传 + 状态机（0 草稿 / 1 已发布 / 2 待审核 / 3 已归档） |
| `ai/` | AI 对话 Agent：`ai-agent.service` 编排循环（意图路由 / 预算 / 门控 / SSE）、会话、`mem0.service` 长期记忆、`memory-cache` 短期记忆 |
| `ai/tools/` | **Agent 工具实现层**（23 号工单）：4 个工具以 `ToolDeps` 注入依赖，不 import `express`；编排层的 `make*Tool` 只是 `tool()` 契约的薄包装。改工具逻辑改这里，别改 service |
| `rag/` | 混合检索（BM25 + KNN → RRF → rerank）+ `/ai/chat` SSE |
| `kg/` | Neo4j 图谱：LLM 抽取、Cypher 构图、`/kg/*` 查询 |
| `pipeline/` | 切片 / embedding / `rag.queue` + `search.queue` 消费者 |
| `es/` | **@Global**：`kh_document` 全文索引 + `kh_chunk` 向量索引 |
| `mq/` | **@Global**：RabbitMQ 拓扑 |
| `search/` | `GET /search` 全文检索 |
| `mineru/` | 文档解析三通道 cloud / flash / self-hosted |
| `storage/` | RustFS（S3 兼容，forcePathStyle） |
| `file/` | 解析分发（txt/md 直读，其余走 MinerU） |
| `team/` | 团队与成员管理 |
| `department/` | 部门树（`kh_department`，深度 ≤ 3）+ 部门增删改；写接口挂 `org:manage` |
| `user/` | **管理端**用户 CRUD（列表 / 建 / 改 / 删 / 角色 / 部门归属），类名刻意叫 `UserAdminService` 以免与 `auth/` 下的 `UserService` 混淆 |
| `operation/` | 操作日志（审计）：只读 `GET /operation`，写入由各域**显式埋点**调用 `record()`，无写接口 |
| `stats/` | 大盘聚合：`GET /stats/dashboard` + `/stats/mine`，跨域只读、不建表 |
| `announcement/` | 系统公告 CRUD（21 号工单）：读接口仅登录，写接口挂 `announcement:manage` |
| `common/` | snowflake-id 工具 |

⚠️ `rag/ai.controller.ts` 与 `ai/ai.controller.ts` **同名不同模块**，改之前先确认路径。

> **本表若与实际 `ls src/` 结果不符，说明本文件已过期 —— 先报告，不要照表行事。**

### 后端硬约定（违反会被 review 打回）

- **不加 Repository 抽象层**：Controller → Service → 直接注入 `Repository<T>` / `Model<T>`
- **不加拦截器 / 异常过滤器 / 响应包装**：接口直接返回业务对象。`{code, data, message}` 外壳是**前端 Mock 独有**，不是后端约定
- **所有接口默认需要登录**，用 `@Public()` 放行
- **雪花 ID 一律经 `normalizeSnowflakeId` 转字符串出参**（防 JS 大整数精度丢失）
- **禁止开启 TypeORM `synchronize`**：表结构靠 `init-scripts/postgresql/init.sql` 手工维护
- 构造 TypeORM `where` 必须显式判 `!== undefined`，不能用真值判断（`0` / `false` 是合法值）
- `/document/reviews/*` 路由必须声明在 `@Get(':id')` **之前**
- 静态子路径一律声明在 `@Get(':id')` 之前（同款：`/department/tree`）—— 否则被 `:id` 吃掉
- TypeORM 0.3 取部分列必须用**对象形式** `select: { id: true }`；数组形式 `select: ['id']` 报 `TS2559`
- 校验用 class-validator；**zod 仅用于 LLM 结构化输出**

### 权限码语义（`kh_permission`）

- `permission_type`：`1` = 菜单（必须有 `menu_url`），`2` = 按钮
- **前端子菜单可见性只看菜单码**（`system:*`），按钮渲染用 `v-permission` 按钮码 —— **两者不能互相替代**
- 后端 `@RequirePermission` 是**显式标注式**（非全局强制）：未标注即零开销放行；`ROLE_ADMIN` 经 `PermissionsGuard` 旁路通过全部权限码
- ⚠️ **给非 Admin 角色授按钮码时，其父菜单码不必同授，且往往不该授**：`system:dept` 的父菜单是顶层 `system`，而 `ROLE_USER` 本就没有 `system` —— 单授子菜单码是**死码**。此时按钮码只作「接口级能力码」存在（能调接口、看不到管理页），与 `team:*` 的既有约定一致
- ⚠️ **权限码 ID 不要跨工单预约**：工单里预先分配的号段必然撞车（18 号预留的 `…0061/0062` 已被 17 号占用）。实施时现查现取
- ⚠️ **ROLE_ADMIN 的接口旁路 ≠ 菜单可见**：`PermissionsGuard` 对 ROLE_ADMIN 放行全部权限码，但 `PermissionService.getUserPermissions()` 只做「角色权限 ∪ 直赋权限」，**没有 admin 全量旁路**。新加的菜单码不写进 `kh_role_permission`，admin 调得动接口却**看不到菜单**（21 号工单踩过）

### 前端硬约定

- **snake_case 红线**：后端字段名（`parse_state` / `is_public` / `author_id`…）只允许出现在 `src/api/adapters/` **一个目录内**。视图层出现 snake_case 即等于隔离失守
- 组件只依赖 `src/api/`；`http.ts` 负责拆 `{code, data, message}` 包
- 无任何 `.env*` 文件，只消费 `VITE_ENABLE_MOCK` / `BASE_URL` / `DEV`
- 代码风格：无分号 / 单引号 / printWidth 100；主色 `#1a66ff`

## 3 已知坑（改之前先看）

**后端**

- MQ 消费失败**仅记日志并 ack**，无 DLQ、无重投（代码内已标 TODO）
- refresh Token **无服务端吊销**，泄露窗口 = refresh 有效期（默认 7d）
- 文档 CRUD 未做归属校验；`author_id` / `create_by` 取自请求体而非 Token
- 无 Swagger / 无健康检查模块 / 无 Dockerfile / 无 CI
- ⚠️ **时间戳有两套时钟基准并存**，写任何时间边界前必看：
  - `kh_document.created_at` / `kh_operation_log.created_at` 走 DB `DEFAULT now()`（会话 `Etc/UTC`）→ 列里是 **UTC 字面**
  - `kh_user.last_login_at` 走应用 `new Date()`（18 号工单）→ 列里是 **本地字面**
  - 根因：`timestamp without time zone` 丢时区，node-postgres 把 `Date` 参数按**本地字段**序列化成 `...+08:00`，PostgreSQL 对 `timestamp` **静默忽略**该偏移
  - 处置：按字段基准传字符串，用 `stats.service.ts` 的 `utcLiteral()` / `localLiteral()`，别用 `MoreThanOrEqual(Date)` 赌驱动行为
  - 相关遗留：`created_at` 出参经 pg 按本地解析后再 `toISOString()`，导致**前端展示早 8 小时**（待单开工单统一时区语义）

**前端**

- 无测试框架；`msw` 仅作 Mock 服务器使用

## 4 文档导航

> 全项目文档头部已带 `status` frontmatter，可一条命令拉出地图：
> `grep -rn "^status:" --include="*.md" .`
>
> **`historical` = 已完成工单的设计记录。改代码时以代码为准，不要照文档改代码。**

### 4.1 `current` —— 契约与决策（必读）

| 要改的东西 | 先读 |
|---|---|
| 前后端联调契约 | `backend-integration/spec.md` |
| 联调待办清单 | `backend-integration/backend-todo.md` |
| 前端架构决策 | `knowledge-hub-front/docs/adr/`（0001~0006） |
| 前端 MVP 契约 | `knowledge-hub-front/.scratch/knowledge-hub-mvp/spec.md`（**唯一事实源**） |
| RBAC 权限体系 | `knowledge-hub-backend/doc/rbac-权限模块工单.md` |
| 团队模块接入（前端） | `backend-integration/issues/15-team-frontend-integration.md` |
| 目录树域（folder） | `backend-integration/issues/16-folder-domain.md` |
| 分类与标签域（category / tag） | `backend-integration/issues/17-doc-meta-domain.md` |
| 用户与部门域（user / department） | `backend-integration/issues/18-user-org-domain.md` |
| 操作日志域（operation / 审计） | `backend-integration/issues/19-operation-log.md` |
| 大盘聚合（stats / dashboard） | `backend-integration/issues/20-dashboard-stats.md` |
| 系统公告（announcement） | `backend-integration/issues/21-announcement-domain.md` |
| Agent 工具可用性契约（门控 + 结构化拒绝） | `backend-integration/issues/22-tool-availability-contract.md` |
| Agent 工具层抽取（`ai/tools/` 契约） | `backend-integration/issues/23-agent-tool-layer-extraction.md` |
| 评测套件（12 项指标 / `test/eval/`） | `backend-integration/issues/24-eval-suite.md` |
| 评测复盘（踩坑与口径修正、未处理项） | `backend-integration/issues/24R-eval-retrospective.md` |

### 4.2 `evolving` —— 进行中（了解下一步）

| 主题 | 文档 |
|---|---|
| 角色权限管理 | `backend-integration/issues/06-role-permission-plan.md` |
| KG 全景页 | `backend-integration/issues/07-kg-overview-phase2.md` |
| 文档可见性（ACL） | `backend-integration/issues/09-document-visibility-plan.md` |
| Agentic RAG | `backend-integration/issues/11-agentic-rag.md` |
| Graph RAG | `backend-integration/issues/12-graph-rag.md` |
| **Mock 模块建设总纲** | `backend-integration/issues/14-mock-modules-backlog.md`（入口，含依赖图与排序） |

> **AI 对话演进链**：`06/07` → `09` → `11` → `12`。其中 `11`、`12` 明确声明**不推翻** `08` 的流式协议与 tool-calling 骨架 —— 改 AI 对话链路时，先确认自己站在这条链的哪一环。
>
> **Mock 资源建设链**：`14`（总纲）→ `15/16/17/18`（并行）→ `19` → `20` → `21`。这 8 份工单把剩余的 7 个 Mock 资源（folders / users / stats / categories / tags / announcements / operations）+ departments + team 接入真实后端，并**撤销工单 05 的降级清单**。改任一处前先读 `14` 的依赖图与决策记录。
>
> **进度**：`15`（团队）、`16`（目录树）、`17`（分类与标签）、`18`（用户与部门）、`19`（操作日志）、`20`（大盘聚合）、`21`（公告）均已交付并转为 `current` —— **Mock 资源建设链（15→21）全部完成**，工单 05 的降级清单已撤销。Agent 侧 `23`（工具层抽取）、`22`（工具可用性契约）亦已交付；`22` 的两条编排层断言待「ModelFactory 注入」重构后才能单测。

### 4.3 `historical` —— 设计背景（默认不读，仅在需要理解「当初为什么这么设计」时查）

| 模块 | 设计背景文档 |
|---|---|
| RAG 检索 / 问答 | `knowledge-hub-backend/.trae/documents/rag-retrieval-chat-plan.md` |
| AI 对话 Agent | `backend-integration/issues/08-ai-chat-agent.md` |
| AI 记忆管线 | `backend-integration/issues/10-ai-memory-pipeline.md` |
| KG 构图管线（Neo4j） | `knowledge-hub-backend/.trae/documents/document-kg-pipeline-neo4j.md` |
| KG 检索 API | `knowledge-hub-backend/.trae/documents/kg-graph-search-api.md` |
| 文档状态流转 / 审核 | `knowledge-hub-backend/.trae/documents/document-status-flow-review.md` |
| 上传与解析 | `knowledge-hub-backend/.trae/documents/minergu-upload-parse.md` |
| 全文检索管线 / 过滤高亮 | `knowledge-hub-backend/.trae/documents/search-fulltext-*.md` |
| 发布 → RAG 管线 | `knowledge-hub-backend/.trae/documents/document-publish-rag-pipeline.md` |
| 鉴权 / 双 Token | `knowledge-hub-backend/.trae/documents/user-auth-module-plan.md` |
| 邮箱激活 / 密码重置 | `knowledge-hub-backend/.trae/documents/user-email-verification-password-reset-plan.md` |
| 团队模块 | `knowledge-hub-backend/.trae/documents/team-module-plan.md` |
| 文档 DB 映射 | `knowledge-hub-backend/.trae/documents/document-database-mapping.md` |
| 前端 MVP 工单 | `knowledge-hub-front/.scratch/knowledge-hub-mvp/issues/01~13` |

**永不读**：`**/dist/`、`**/node_modules/`、`knowledge-hub-backend/volumes/`

## 5 文档约定

- 设计 / 工单文档头部统一 YAML frontmatter：`status: current | evolving | historical` + `updated: YYYY-MM-DD`
- **只索引 `status: current`** 的文档；未列出者默认不读
- 新增文档时顺手补 frontmatter；**不需要**回头改本文件（触发索引按目录通配）
- `README.md` 是给人看的，**要拆改先问**
