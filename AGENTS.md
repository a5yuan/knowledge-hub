# AGENTS.md

> 本项目**给 AI 编码工具**的地图。人类读者请看 `README.md`（27 KB，结构完整）。
> 校验日期：2026-09-28（§0 工作区于 2026-10-07 复核修正）。**若发现本文件与实际不符，先把差异报告给用户，再动手。**

## 0 工作区

企业级知识库（Knowledge Hub）：NestJS 11 后端 + Vue 3 前端，RAG + 知识图谱双链路。

| 目录 | 说明 |
|---|---|
| `knowledge-hub-backend/` | 后端，**独立 git repo**，`src/` 113 个 ts |
| `knowledge-hub-front/` | 前端，**独立 git repo**，`src/` 78 个源文件 |
| `backend-integration/` | 跨仓库联调层（`spec.md` + `issues/01~12`） |
| `README.md` | 面向人类的总览 |

⚠️ **根目录是 git 仓库**，只跟踪根层文档（`AGENTS.md` / `README.md` / `backend-integration/`）；`knowledge-hub-backend/` 与 `knowledge-hub-front/` 是**各自独立的嵌套 repo**，根仓库不跟踪其内容 —— 提交前先确认自己在哪个仓库。扫描时排除：`**/node_modules/`（约 9.9 万文件）、`knowledge-hub-backend/volumes/`（916 MB 中间件数据）、`**/dist/` —— 排除项于 2026-09-28 实测。

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
| `ai/` | AI 对话 Agent：`ai-agent.service` 循环、会话、`mem0.service` 长期记忆、`memory-cache` 短期记忆 |
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
- 校验用 class-validator；**zod 仅用于 LLM 结构化输出**

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

### 4.2 `evolving` —— 进行中（了解下一步）

| 主题 | 文档 |
|---|---|
| 角色权限管理 | `backend-integration/issues/06-role-permission-plan.md` |
| KG 全景页 | `backend-integration/issues/07-kg-overview-phase2.md` |
| 文档可见性（ACL） | `backend-integration/issues/09-document-visibility-plan.md` |
| Agentic RAG | `backend-integration/issues/11-agentic-rag.md` |
| Graph RAG | `backend-integration/issues/12-graph-rag.md` |

> 这是一条**演进链**：`06/07` → `09` → `11` → `12`。其中 `11`、`12` 明确声明**不推翻** `08` 的流式协议与 tool-calling 骨架 —— 改 AI 对话链路时，先确认自己站在这条链的哪一环。

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
