# 企业级知识库系统（Knowledge Hub）

面向企业的文档知识管理平台，打通「文档上传 → 解析 → 索引 → 检索 → 知识图谱 → AI 问答」的完整链路。

> 当前状态：**前后端已完成联调**（双通道：Mock 兜底 + 真实后端），文档、检索、RAG 索引、知识图谱、AI Agent 问答均已落地。6 个核心资源走真实后端，其余仍由 MSW Mock 承载，详见[前后端联调现状](#前后端联调现状)。

> **AI 编码工具（Claude Code / Codex / Cursor 等）请先读 [`AGENTS.md`](./AGENTS.md)** —— 那是给 AI 的薄地图。本文件是给人读的完整文档，篇幅较长，不必作为 AI 的入口。

---

## 目录结构

```
企业级知识库/                      # 单一 git 仓库，前后端同仓管理
├── knowledge-hub-front/       # 前端：Vue 3 + Vite + Element Plus（SPA）
├── knowledge-hub-backend/     # 后端：NestJS + PG / Mongo / ES / Redis / Neo4j / RabbitMQ
├── AGENTS.md                  # 给 AI 编码工具的项目地图（触发索引 + 硬约定）
└── README.md                  # 本文件
```

> 另有 `.trae/`（早期计划文档）与 `.workbuddy/`（工作区数据 + 文档备份）两个隐藏目录。

---

## 整体架构

```
                          ┌───────────────────────────┐
                          │   knowledge-hub-front     │
                          │  Vue3 / Pinia / Element+  │
                          │  MSW Mock（开发期默认开启） │
                          └─────────────┬─────────────┘
                                        │  /api/*  → Mock（MSW 拦截）
                                        │  /real/* → Vite 代理 → :3000
                          ┌─────────────▼─────────────┐
                          │   knowledge-hub-backend   │
                          │      NestJS 11 (3000)     │
                          └──┬────┬────┬────┬────┬────┘
                             │    │    │    │    │
              ┌──────────────┘    │    │    │    └──────────────┐
              ▼                   ▼    │    ▼                 ▼
      ┌──────────────┐   ┌──────────┐  │  ┌─────────┐  ┌────────────┐
      │ PostgreSQL16 │   │ MongoDB7 │  │  │  Redis7 │  │   Neo4j    │
      │  元数据/用户  │   │ 文档正文  │  │  │ 验证码  │  │  知识图谱   │
      └──────────────┘   └──────────┘  │  └─────────┘  └─────▲──────┘
                                       │                      │
                          ┌────────────▼──────────┐           │
                          │      RabbitMQ         │           │
                          │ document.events (direct)│          │
                          │  ├─ rag.queue  ────────┼───────────┤
                          │  ├─ kg.queue   ────────┼───────────┘
                          │ kh.document.exchange   │
                          │  └─ search.queue ──────┼──┐
                          └───────────────────────┘  │
                                                     ▼
                                            ┌─────────────────┐
                                            │ Elasticsearch   │
                                            │ kh_document     │← 全文检索(IK)
                                            │ kh_chunk        │← 向量(dense_vector)
                                            └─────────────────┘
                                                     ▲
                                    ┌────────────────┘
                                    │
                          ┌─────────┴─────────┐
                          │  RustFS (S3 兼容)  │  原始文件存储
                          └───────────────────┘
```

**入库链路（发布驱动）**：上传文件 → RustFS 对象存储 → FileService 分发解析（txt/md 直读，其余走 MinerU）→ 正文写入 MongoDB、元数据写入 PostgreSQL → **`/publish` 或审核通过触发 RabbitMQ 三类事件** → 分别构建 ES 全文索引、ES 向量分块、Neo4j 知识图谱。

> ⚠️ 分块不是在上传时发生：`rag.queue` 与 `kg.queue` 的消费者各自**回查 Mongo 取正文再分块**，同一份文档被切两次。

**问答链路**：`/ai/sessions/messages`（SSE）→ 意图路由 Planner（五类意图）→ 上下文装配（Mem0 长期记忆 + 会话记忆 + 早期摘要）→ 意图门控的前置检索 + 切题评估 Grader → 手写 tool-calling 循环（`retrieve_knowledge` / `rewrite_query` / `web_search` / `retrieve_graph`）→ 引用过滤 → 最终回答 + 推荐追问。

---

## 一、后端 knowledge-hub-backend

### 技术栈

| 分类        | 选型                                                                                              |
| ----------- | ------------------------------------------------------------------------------------------------- |
| 框架 / 语言 | NestJS 11 + TypeScript 5.7（`module: nodenext`, target ES2023）                                   |
| 包管理      | pnpm                                                                                              |
| 关系库      | PostgreSQL 16（pgvector 镜像）+ TypeORM（`synchronize: false`）                                   |
| 文档库      | MongoDB 7 + Mongoose（存 Markdown 正文）                                                          |
| 检索引擎    | Elasticsearch 8.17 + IK 中文分词（自建镜像）                                                      |
| 图数据库    | Neo4j（APOC）+ neo4j-driver                                                                       |
| 缓存        | Redis 7（ioredis）——邮箱激活 Token、重置验证码                                                    |
| 消息队列    | RabbitMQ 3.13（amqp-connection-manager）                                                          |
| 对象存储    | RustFS（S3 兼容，`@aws-sdk/client-s3`，forcePathStyle）                                           |
| 文档解析    | mineru-open-sdk（cloud / flash / self-hosted 三通道）                                             |
| AI / RAG    | LangChain（`@langchain/openai`、`core/tools`、`textsplitters`）+ zod 结构化输出                   |
| 重排        | dashscope 原生 `text-rerank` 端点（非 OpenAI 兼容协议）                                           |
| 可观测      | Langfuse v4（`@langfuse/tracing` + OpenTelemetry），默认走云端，`LANGFUSE_ENABLED=false` 一键关闭 |
| 鉴权        | `@nestjs/jwt` + passport-jwt + bcryptjs（双 Token + RBAC 权限模型）                               |
| 邮件        | `@nestjs-modules/mailer` + nodemailer（SMTP）                                                     |
| 校验        | class-validator + class-transformer；zod 仅用于 LLM 输出                                          |
| ID 生成     | snowflake-id（应用侧生成，**统一以字符串传输**）                                                  |

### 目录结构（src/）

```
src/
├── main.ts               # 启动：import 'dotenv/config' 首行 → initTracing() → NestFactory.create
├── app.module.ts         # 根模块：ConfigModule(global) / TypeORM / Mongoose 组装
├── app.controller.ts     # @Public() GET / 健康检查
├── auth/                 # 用户与鉴权 + RBAC
│   ├── auth.controller.ts / auth.service.ts / user.service.ts / role.controller.ts
│   ├── permission.service.ts      # 权限码 → 角色的映射
│   ├── mail.service.ts / redis.service.ts
│   ├── decorators/       # @Public / @Roles / @CurrentUser
│   ├── guards/           # JwtAuthGuard / RolesGuard / PermissionsGuard（全局）
│   ├── strategies/       # jwt.strategy.ts
│   ├── dto/ entities/ interfaces/
├── document/             # 文档主域：CRUD + 上传 + 发布/审核状态机
│   ├── document.controller.ts / document.service.ts
│   ├── dto/              # create / update / query / upload / review-action
│   ├── entities/         # document.entity、document-review.entity（TypeORM）
│   └── schemas/          # document-content.schema（Mongoose）
├── file/                 # FileService：解析分发（txt/md 直读，其余走 MinerU）
├── mineru/               # MineruService：cloud | flash | self-hosted 三通道
├── storage/              # RustfsService：S3 客户端、启动时自动建桶
├── mq/                   # @Global MqService：RabbitMQ 拓扑、发布/消费
├── es/                   # @Global：es.service、doc-index.service(kh_document)、
│                         #          vector-index.service(kh_chunk 向量索引)、visibility-scope
├── pipeline/             # RAG 管线：chunker、embedding.service、
│                         #           pipeline.service(rag.queue 消费者)、
│                         #           search-index.service(search.queue 消费者)
├── kg/                   # 知识图谱：neo4j.service、extraction.service(LLM+zod)、
│                         #           kg.service(Cypher 构图/查询)、kg-pipeline.service、
│                         #           kg-query.controller
├── search/               # SearchController：GET /search、GET /search/doc/:docId
├── rag/                  # RAG 检索问答：rag-search.service(混合检索 BM25+KNN→RRF→rerank)、
│                         #           rerank.service(精排)、ai-chat.service(/ai/chat SSE)、
│                         #           rag.controller(/rag/search)、ai.controller(/ai/chat)
├── ai/                   # AI 对话 Agent：ai-agent.service(意图路由+Agent 循环)、
│                         #           ai-session.service、mem0.service(长期记忆)、
│                         #           memory-cache.service(短期记忆)、ai.controller
├── team/                 # 团队与成员管理
├── observability/        # Langfuse tracing：tracing.ts(引导)、tracing.service、module
└── common/utils/         # snowflake-id.util.ts
```

> ⚠️ `rag/ai.controller.ts` 与 `ai/ai.controller.ts` **同名不同模块**，都挂在 `/ai` 前缀下（前者 `/ai/chat`，后者 `/ai/sessions/*`）——改之前先确认路径。

### 架构约定

- **分层**：Controller（薄）→ Service → 直接注入 `Repository<T>` / `Model<T>`，**没有额外 Repository 抽象层**。
- **全局守卫**：`JwtAuthGuard` + `RolesGuard` + `PermissionsGuard` 注册为 `APP_GUARD`（`src/auth/auth.module.ts`）。**所有接口默认需要登录**，用 `@Public()` 放行；`@Roles('ROLE_X')` 做角色校验，`PermissionsGuard` 做权限码校验。
- **无自定义拦截器 / 异常过滤器 / 响应包装器**：接口直接返回业务对象，没有统一 `{code, data, message}` 外壳（该外壳是**前端 Mock 独有**）。
- **DTO 校验**：class-validator 装饰器 + `@Type(() => Number)` 做查询串转数字；`UpdateDocumentDto` 用 `PartialType` 派生。
- **ID 规范**：雪花 ID 一律经 `normalizeSnowflakeId` 转字符串后再出参，避免 JS 大整数精度丢失。
- **Schema 管理**：**不使用 TypeORM migration**，表结构由 `init-scripts/postgresql/init.sql` 维护，`synchronize: false`（禁止开启）。
- **可选字段查询**：构造 TypeORM `where` 时必须显式判 `!== undefined`，不能用真值判断（`0` / `false` 是合法值）。
- **降级不报错**：检索重排、LLM、tracing、记忆等外围依赖失败一律只记日志并降级，不抛 500。

### 数据模型

**PostgreSQL（kh_ 前缀）**

| 表                   | 说明                                                                                                                                                  |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `kh_document`        | 文档元数据。`status`：0 草稿 / 1 已发布 / 2 待审核 / 3 已归档；含 `content_id`（指向 Mongo ObjectId）、分类、团队、标签、统计计数、逻辑删除 `deleted` |
| `kh_document_review` | 审核记录。`review_result`：NULL 待审 / 1 通过 / 2 驳回；含待审部分索引                                                                                |
| `kh_user`            | 用户。bcrypt(cost 10)，`username` 带 `WHERE deleted = false` 的部分唯一索引                                                                           |
| `kh_role`            | 角色。内置 `ROLE_ADMIN` / `ROLE_REVIEWER` / `ROLE_USER`                                                                                               |
| `kh_user_role`       | 用户-角色关联，唯一约束 (user_id, role_id)                                                                                                            |

初始脚本内置测试账号 `admin` / `reviewer` / `user`，密码均为 `123456`。

**MongoDB**：`document_content` 集合，存 Markdown 正文，含 `parse_state`（pending/running/success/failed）、`source_file_key`、`version`、`images[]`。

**Elasticsearch**

- `kh_document`：文档级快照，title/summary/content 使用 `ik_max_word` + `ik_smart`，`_id = docId` 幂等 upsert，检索走 `multi_match`（title 加权 2）。
- `kh_chunk`：RAG 分块，`content` 为 IK 分词的 `text`，`embedding` 为 `dense_vector`（维度取 `EMBEDDING_DIMS`，默认 1024，cosine）。**同一个索引承载混合检索的两路**：`multi_match`（BM25）走文本字段，`knn` 走向量字段。另透传 `author_id` / `team_id` / `status` / `is_public` 供召回阶段做可见性过滤（缺省 fail-closed）。

**Neo4j 图模型**：`(:Document)-[:HAS_CHUNK]->(:Chunk)-[:MENTIONS]->(:Entity)-[:RELATED_TO]->(:Entity)`

### 鉴权与权限设计

- **注册**：`POST /auth/register` → 唯一性校验 → 雪花 ID + bcrypt → 绑定 `ROLE_USER`。当 `REQUIRE_EMAIL_VERIFICATION=true` 时写入 Redis 24h 激活 Token（`email:activation:<token>`）并发激活邮件；邮件失败会回滚用户记录。
- **登录**：`POST /auth/login` → 用户不存在/密码错误统一返回 401（防枚举）→ 邮箱未激活返回 403、账号禁用返回 403 → 签发**双 Token**。
- **双 Token**：access（`type: 'access'`，默认 2h）+ refresh（`type: 'refresh'`，默认 7d），HS256。刷新时校验类型并轮换两个 Token。**无服务端吊销/黑名单**，泄露窗口最长为 refresh 有效期。
- **JwtStrategy**：每次请求都会**回查数据库**构建 `request.user`，保证角色变更/禁用/删除即时生效；refresh Token 无法调用业务接口。
- **RBAC 权限模型**：`kh_role` + `kh_user_role` 决定角色，`permission.service.ts` 维护权限码映射，`GET /auth/permissions` 下发当前用户权限码集合，前端按权限码控制菜单与页面访问。
- **密码重置**：`POST /auth/password/send-code`（仅已验证账号，6 位随机码，Redis 10 分钟）→ `POST /auth/password/reset`（验证码一次性消费）。
- **邮件降级**：当 `MAIL_USER` 为空或为 `xx@xx.com` 时，激活链接/验证码直接打印到日志，本地开发无需配置 SMTP。

### API 一览

**无全局路由前缀**，服务地址 `http://localhost:3000`。除 `@Public()` 标注外，全部需要 `Authorization: Bearer <accessToken>`。

**`/auth`**

| 方法 | 路径                        | 说明                               |
| ---- | --------------------------- | ---------------------------------- |
| POST | `/auth/register`            | 注册（public）                     |
| GET  | `/auth/verify-email?token=` | 邮箱激活，返回 HTML 页面（public） |
| POST | `/auth/resend-activation`   | 重发激活邮件（public）             |
| POST | `/auth/password/send-code`  | 发送重置验证码（public）           |
| POST | `/auth/password/reset`      | 重置密码（public）                 |
| POST | `/auth/login`               | 登录，返回双 Token（public）       |
| POST | `/auth/refresh`             | 刷新 Token（public）               |
| GET  | `/auth/me`                  | 当前用户信息                       |
| GET  | `/auth/permissions`         | 当前用户权限码集合                 |
| GET  | `/auth/reviewer-ids`        | 审核人列表                         |

**`/role`**

| 方法   | 路径                    | 说明                         |
| ------ | ----------------------- | ---------------------------- |
| GET    | `/role/permission-tree` | 权限树（权限配置弹窗数据源） |
| GET    | `/role/list`            | 角色列表                     |
| POST   | `/role`                 | 新建角色                     |
| PATCH  | `/role/:id`             | 更新角色                     |
| DELETE | `/role/:id`             | 删除角色                     |
| GET    | `/role/:id/permissions` | 角色已授权限                 |
| PUT    | `/role/:id/permissions` | 覆写角色权限                 |

**`/document`**

| 方法   | 路径                              | 说明                                                                             |
| ------ | --------------------------------- | -------------------------------------------------------------------------------- |
| POST   | `/document/upload`                | multipart 上传（字段 `file`），≤10MB，后台异步解析，返回 `poll_url`              |
| POST   | `/document`                       | 新建文档                                                                         |
| GET    | `/document`                       | 分页列表，支持 id/title/category_id/team_id/author_id/tags/status/is_public 过滤 |
| GET    | `/document/reviews/pending/count` | 待审数量                                                                         |
| GET    | `/document/reviews/pending`       | 待审列表                                                                         |
| GET    | `/document/:id/reviews`           | 某文档审核记录                                                                   |
| GET    | `/document/:id`                   | 详情（含正文与 parse_state）                                                     |
| PATCH  | `/document/:id`                   | 局部更新（status 0→1 触发发布事件）                                              |
| POST   | `/document/:id/publish`           | 发布（`REVIEW_ENABLED=true` 时为提审）                                           |
| POST   | `/document/:id/approve`           | 通过（`ROLE_REVIEWER` / `ROLE_ADMIN`）                                           |
| POST   | `/document/:id/reject`            | 驳回，必填意见（同上角色）                                                       |
| POST   | `/document/:id/save-draft`        | 存草稿                                                                           |
| POST   | `/document/:id/archive`           | 归档                                                                             |
| DELETE | `/document/:id`                   | 逻辑删除，同时清理 Mongo / ES / 图谱索引                                         |

**`/search`**

| 方法 | 路径                         | 说明                                                                  |
| ---- | ---------------------------- | --------------------------------------------------------------------- |
| GET  | `/search?q=&page=&pageSize=` | ES 全文检索 `kh_document`，`q` 必填（1-100 字符），`pageSize` 上限 50 |
| GET  | `/search/doc/:docId`         | 单文档检索详情（含命中高亮）                                          |

**`/rag`**

| 方法 | 路径                   | 说明                                                                                 |
| ---- | ---------------------- | ------------------------------------------------------------------------------------ |
| GET  | `/rag/search?q=&topK=` | 混合检索：BM25 + 向量 KNN → RRF 融合 → Rerank 精排，返回切题片段（按用户可见性过滤） |

**`/ai`**

| 方法   | 路径                        | 说明                                                                        |
| ------ | --------------------------- | --------------------------------------------------------------------------- |
| POST   | `/ai/chat`                  | 简单问答 SSE（混合检索 → 拼 prompt → LLM 流式，不带 Agent）                 |
| GET    | `/ai/sessions`              | 会话列表                                                                    |
| POST   | `/ai/sessions`              | 新建会话                                                                    |
| POST   | `/ai/sessions/messages`     | **Agent 对话 SSE（主入口）**：意图路由 → 记忆 → 检索/切题 → 工具循环 → 引用 |
| GET    | `/ai/sessions/:id/messages` | 会话历史消息                                                                |
| DELETE | `/ai/sessions/:id`          | 删除会话                                                                    |
| DELETE | `/ai/sessions/:id/messages` | 清空会话消息                                                                |

**`/kg`**

| 方法 | 路径                                     | 说明                                              |
| ---- | ---------------------------------------- | ------------------------------------------------- |
| GET  | `/kg/overview`                           | 全景图谱（节点/边 + 统计 + 类型分布 + 热点 TOP5） |
| GET  | `/kg/search?q=&type=`                    | 聚合搜索（实体 + 关系 + 文档直连边）              |
| GET  | `/kg/nodes?label=&q=&page=&pageSize=`    | 通用节点查询（entity / document / chunk）         |
| GET  | `/kg/edges?rel=&entity=&page=&pageSize=` | 通用关系查询（related_to / mentions / has_chunk） |

**`/team`**

| 方法   | 路径                        | 说明         |
| ------ | --------------------------- | ------------ |
| POST   | `/team`                     | 新建团队     |
| GET    | `/team`                     | 团队列表     |
| GET    | `/team/:id`                 | 团队详情     |
| PATCH  | `/team/:id`                 | 更新团队     |
| DELETE | `/team/:id`                 | 删除团队     |
| POST   | `/team/:id/members`         | 添加成员     |
| GET    | `/team/:id/members`         | 成员列表     |
| PATCH  | `/team/:id/members/:userId` | 调整成员角色 |
| DELETE | `/team/:id/members/:userId` | 移除成员     |

> 路由顺序注意：`document/reviews/*` 必须声明在 `@Get(':id')` 之前。

### 异步消息拓扑

| Exchange               | 类型   | 队列                       | 路由键           | 消费者                                                            |
| ---------------------- | ------ | -------------------------- | ---------------- | ----------------------------------------------------------------- |
| `document.events`      | direct | `rag.queue`                | `rag`            | `PipelineService`（回查正文 → 分块 + 向量化 → kh_chunk）          |
| `document.events`      | direct | `kg.queue`                 | `kg`             | `KgPipelineService`（回查正文 → 分块 → LLM 抽取实体关系 → Neo4j） |
| `kh.document.exchange` | topic  | `kh.document.search.queue` | `document.index` | `SearchIndexService`（整篇快照 → kh_document，不回查库）          |

手动 ack，`prefetch: 1`；消费者失败**仅记录日志并 ack**（无 DLQ、无重投，代码中已标 TODO）。发布事件为 best-effort，单个队列失败不影响其他队列。

### 环境变量

真实 `.env` 已 gitignore、**永不入库**。完整清单与分组说明见 [`knowledge-hub-backend/.env.example`](./knowledge-hub-backend/.env.example)，复制为 `.env` 后填空即可。

**模型与对应 Token（重点）**

| 变量                                                                                     | 用途                                                                                      |
| ---------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `OPENAI_API_KEY`                                                                         | **共用密钥**：向量化 / 对话 LLM / 重排 / 记忆抽取四条链路都读它（DashScope key 一个通用） |
| `EMBEDDING_BASE_URL`                                                                     | OpenAI 兼容端点（embedding / LLM / rerank 三处共用）                                      |
| `EMBEDDING_MODEL` / `EMBEDDING_DIMS`                                                     | 向量化模型与维度（默认 1024，改动需重建索引）                                             |
| `LLM_MODEL`                                                                              | 对话主模型 + KG 实体抽取模型，默认 `qwen-plus`                                            |
| `MEMORY_LLM_MODEL`                                                                       | 轻量工具模型（意图路由 / 切题评估 / 记忆抽取），默认 `qwen-turbo`                         |
| `RERANK_MODEL` / `RERANK_API_URL`                                                        | 重排模型与端点（dashscope 原生协议）                                                      |
| `TAVILY_SEARCH`                                                                          | 联网搜索独立 Token（不配则 `web_search` 降级）                                            |
| `MEM0_API_KEY` / `MEM0_BASE_URL`                                                         | Mem0 长期记忆独立 Token                                                                   |
| `MINERU_PROVIDER` / `MINERU_API_TOKEN`                                                   | MinerU 通道与云端 Token（`cloud` 通道才需要）                                             |
| `LANGFUSE_ENABLED` / `LANGFUSE_PUBLIC_KEY` / `LANGFUSE_SECRET_KEY` / `LANGFUSE_BASE_URL` | Langfuse 可观测（默认云端）                                                               |

> ⚠️ 四条模型链路**共用同一个 key**。若要与不同厂商的 key 混用，属代码改动（当前代码只读 `OPENAI_API_KEY`），不是配置改动。

**基础设施与其余配置**：`POSTGRES_*` / `MONGO_URI` / `REDIS_*` / `RABBITMQ_URL` / `ES_NODE` / `NEO4J_*` / `RUSTFS_*` / `RAG_CHUNK_MAX_CHARS` / `RAG_SCORE_THRESHOLD` / `JWT_SECRET` / `JWT_ACCESS_EXPIRES` / `JWT_REFRESH_EXPIRES` / `REVIEW_ENABLED` / `REQUIRE_EMAIL_VERIFICATION` / `APP_PUBLIC_URL` / `MAIL_*` / `PORT`。

### 依赖中间件（`docker.compose.yml`）

> 注意文件名是 `docker.compose.yml`，不是 `docker-compose.yml`。全部数据持久化到 `./volumes/`（**916 MB，已 gitignore**）。

| 服务          | 镜像                     | 端口         | 凭据                       |
| ------------- | ------------------------ | ------------ | -------------------------- |
| postgres      | pgvector/pgvector:pg16   | 5432         | user / 123456              |
| pgadmin       | dpage/pgadmin4           | 8088→80      | admin@admin.com / admin    |
| mongodb       | mongo:7-jammy            | 27017        | mongo_user / mongo_pass123 |
| mongo-express | mongo-express:1.0.2      | 8081         | me_admin / me_123456       |
| rabbitmq      | rabbitmq:3.13-management | 5672 / 15672 | guest / guest              |
| es            | 本地构建（8.17.0 + IK）  | 9200         | 安全已关闭                 |
| kibana        | kibana:8.17.0            | 5601         | —                          |
| rustfs        | rustfs/rustfs:latest     | 9000 / 9001  | rustfsadmin / rustfsadmin  |
| neo4j         | neo4j:latest + APOC      | 7474 / 7687  | neo4j / 12345678           |
| redis         | redis:7-alpine           | 6379         | 无                         |
| redisinsight  | redis/redisinsight:2.50  | 5540         | —                          |

以上密码为**本地开发默认值**，与 `.env.example` 一致；生产环境务必更换。

> IE 分词插件 `elasticsearch/ik.zip`（4.5 MB）**随仓库分发**——它是 `elasticsearch/Dockerfile` 的构建必需输入（`COPY ik.zip` + 本地安装），改成构建时下载会因 GitHub 直连不稳而失败。

### 常用命令

```bash
cd knowledge-hub-backend

docker compose -f docker.compose.yml up -d   # 启动全部中间件
pnpm install
pnpm run start:dev                            # 开发（watch）
pnpm run build && pnpm run start:prod         # 生产
pnpm run lint                                 # ⚠️ 见下方警告
pnpm test                                     # 单测
pnpm run test:e2e                             # e2e
pnpm run eval:seed                            # 上传并发布评测语料
pnpm run eval                                 # 跑真实对话 SSE → 八指标 → 回写 Langfuse
```

> ⚠️ **不要跑 `pnpm run lint`**：它带 `eslint --fix` + prettier，实测一次性重排了 63 个无关文件（会大面积改写源码格式）。校验请用 `pnpm run build` + `pnpm test`。该仓库 lint 当前本身也不通过（约 171 项既有类型解析报错）。

测试覆盖：9 个 spec（auth / user / permission / permissions.guard / team / mq / visibility-scope / rag-search / app）+ 1 个 e2e 骨架；真实接口测试用例沉淀在 `test/curl/`（curl 集合 + PowerShell 脚本）。

---

## 二、前端 knowledge-hub-front

### 技术栈

| 分类     | 选型                                                                                    |
| -------- | --------------------------------------------------------------------------------------- |
| 框架     | Vue 3.5（Composition API，`<script setup lang="ts">`）                                  |
| 构建     | Vite 6 + TypeScript 5.7（strict + `noUnusedLocals/Parameters`）                         |
| UI 库    | Element Plus 2.9（图标全局注册）                                                        |
| 状态管理 | Pinia 3                                                                                 |
| 路由     | vue-router 4（history 模式）                                                            |
| HTTP     | axios 1.20                                                                              |
| 富文本   | TipTap 2.27（starter-kit + image + table）                                              |
| Markdown | markdown-it 15 + DOMPurify 3（AI 回答与文档正文渲染，见 ADR-0006）                      |
| 图表     | ECharts 6（按需 `echarts.use([...])` 摇树）+ 自研 `GraphCanvas`（力导图）               |
| Mock     | MSW 2.15（Service Worker 拦截，接口全覆盖）                                             |
| 样式     | 原生 scoped CSS + 全局 `styles/index.css`，覆盖 Element Plus CSS 变量（主色 `#1a66ff`） |
| 规范     | ESLint 9 flat config + Prettier（无分号 / 单引号 / printWidth 100）                     |

### 目录结构（src/）

```
src/
├── api/          # 每个资源一个模块（14 个）+ http.ts / endpoint.ts / session.ts / refresh.ts
│   └── adapters/ # snake_case ⇄ camelCase 隔离层（后端字段名只允许出现在这里）
├── components/
│   ├── charts/   # VChart.vue（ECharts 包装）、GraphCanvas.vue（知识图谱力导图）
│   ├── editor/   # RichEditor.vue（TipTap 包装）、json.ts
│   └── markdown/ # MarkdownView.vue、render.ts（markdown-it + DOMPurify）
├── directives/   # permission.ts（v-permission 权限指令）
├── layouts/      # MainLayout.vue（顶栏 + 横向菜单）
├── mocks/        # MSW：browser / db（内存数据库）/ seed / parse / content /
│                 #       identity（会话桥）/ handlers/
├── router/       # 路由表 + 全局前置守卫
├── stores/       # user.ts（唯一 Pinia store）
├── styles/       # index.css
├── types/        # api.ts（完整领域契约）
└── views/        # login / dashboard / documents / search / ai-qa /
                  # knowledge-graph / profile / admin
```

### 路由

| 路径                     | 名称             | 功能                                                     |
| ------------------------ | ---------------- | -------------------------------------------------------- |
| `/login`                 | login            | 登录（独立布局，`public: true`）                         |
| `/`                      | —                | 重定向到 `/dashboard`                                    |
| `/dashboard`             | dashboard        | 首页大盘：统计卡片 + 趋势折线 + 分类环形 + 最近操作      |
| `/documents`             | documents        | 文档管理（核心页）：四分区 + 目录树 + 列表/卡片          |
| `/documents/reviews`     | document-reviews | 审核工作台（`requiresReviewer`）                         |
| `/documents/:id/edit`    | document-editor  | TipTap 在线编辑                                          |
| `/documents/:id/preview` | document-preview | 文档预览 / 下载                                          |
| `/search`                | search           | 智能搜索（高亮、热门、历史、高级筛选）                   |
| `/ai-qa`                 | ai-qa            | AI 智能问答（Agent 对话 + 过程时间线 + 引用卡片）        |
| `/knowledge-graph`       | knowledge-graph  | 知识图谱（全景图 + 检索 + 统计面板）                     |
| `/profile`               | profile          | 个人中心                                                 |
| `/admin/*`               | admin-*          | 系统管理：`users` / `roles` / `teams`（`requiresAdmin`） |

全局守卫顺序：会话恢复 → public 页跳转 → 登录校验 → `requiresAdmin` → `requiresReviewer` → `meta.permission` 权限码校验（顺序即优先级，权限码校验必须排在登录校验之后）。

### 状态管理

`src/stores/user.ts` 持有 `user`，派生 `isLoggedIn` / `isAdmin` / `canReview` / `roleLabel`，动作 `login` / `restoreSession`（单飞 Promise 避免并发重复请求 `/auth/me`）/ `logout` / `setUser`，并提供 `hasPermission(code)` 供路由守卫与 `v-permission` 指令共用。

Token 不在 store 内，由 `src/api/session.ts` 统一管理**四个会话键**：`kh_token`（access）、`kh_refresh_token`、`kh_token_exp`、`kh_mock_token`（Mock 通道专用），外加版本闸 `kh_session_v`（不匹配即整体失效）。

### 请求层与双通道

`src/api/endpoint.ts` 是**通道决策的唯一入口**，任何 API 模块都不得写字面量路径：

- `baseURL` 编码「走哪个通道」：`/api` = MSW Mock，`/real` = 真实后端
- `url` 编码「资源路径」：Mock 用复数（`/documents`），真实用单数（`/document`）；复数→单数的重写只存在于 `REAL_ROOT` 常量内
- 逃生舱：`localStorage['kh_api_mode']` 可让单个资源回退 Mock，无需改代码重启

`vite.config.ts` 配了两个代理（`server` 与 `preview` **必须成对**，否则构建产物下真实请求会落到 SPA fallback）：

| 前缀       | 目标                    | 说明                                                                                      |
| ---------- | ----------------------- | ----------------------------------------------------------------------------------------- |
| `/real`    | `http://127.0.0.1:3000` | 代理层剥掉 `/real`；用 `127.0.0.1` 而非 `localhost`（Windows 上 Node 可能优先解析 `::1`） |
| `/storage` | `http://127.0.0.1:9000` | RustFS 对象存储，剥前缀直转发                                                             |

`src/api/http.ts`：请求拦截按通道选 Token（`/real` 用 access token，`/api` 用 mock token 并回落 `kh_token`）；响应拦截 401 → **单飞刷新**（`refresh.ts`）成功后重放一次，失败则清凭证跳登录；`request<T>()` 拆包 `{ code, data, message }`，`code !== 0` 抛错。

### Mock 策略（重要）

开发期默认启用 MSW，**尚未接真实后端的资源全部跑在 Mock 上**：

- `src/mocks/db.ts` 是模块级单例内存库，权限与筛选全部实现为纯函数：`canSeeDocument`（admin 全见 / 本人可见 / company 全员可见 / department 同部门可见，不可见即**完全隐藏**而非置灰）、`canManageDocument`、`inZone`、`filterDocuments`、`paginate`、`relevanceScore`。
- `src/mocks/seed.ts` 提供与原型对齐的演示数据；演示账号 `admin` / `li` / `qian` / `wang`，密码均为 `123456`。
- `src/mocks/parse.ts` 模拟解析流程 pending → processing(2-4s) → 90% done / 10% failed。
- `src/mocks/identity.ts` 是**会话桥**：真实登录用户会被镜像进 Mock 内存库并签发 `mock_<userId>_<ts>` token，使 `/api` 端点组在真实登录态下可用。
- `main.ts` 中 **`await worker.start()` 早于 `app.use(router)`**，避免首个守卫的 `/auth/me` 被绕过。
- 关闭 Mock 接真实后端：设置 `VITE_ENABLE_MOCK=false`（生产构建由 `import.meta.env.DEV` 兜底，永不启用 Mock）。

**项目没有任何 `.env*` 文件**，仅消费 `VITE_ENABLE_MOCK`、`BASE_URL`、`DEV` 三个变量。

### 文档能力细节

- **文档管理页**：四分区（我的 / 公开 / 部门 / 归档）、目录树、300ms 防抖搜索、列表⇄卡片切换、排序、行内与批量操作（删除/归档/恢复/移动）、解析状态 **2s 轮询**。
- **在线编辑**：1.5s 防抖自动保存，`saved/dirty/saving` 三态、保存合并、失败重试、`beforeunload` 用 `fetch(keepalive: true)` 兜底、路由离开前等待在途保存。
- **预览**：PDF 用原生 `iframe` 加载 blob URL（iframe 首次导航不受 Service Worker 控制，故不能用 mock 路由直接给 URL）；在线文档只读复用 `RichEditor`；Markdown 用 `MarkdownView`；office/txt 提示下载查看。

### 常用命令

```bash
cd knowledge-hub-front

pnpm install
pnpm dev        # 开发，http://localhost:5173（Mock 默认开启）
pnpm build      # vue-tsc -b && vite build
pnpm preview
pnpm lint
pnpm format
```

### 项目治理

- `docs/adr/` 记录 6 条架构决策：0001 技术选型、0002 混合内容模型、0003 Mock 优先与接口隔离、0004 AI/图谱一期先落 `parseStatus`、0005 双通道混合模式、0006 Markdown 正文渲染。
- `.scratch/knowledge-hub-mvp/spec.md` 是 MVP 的**唯一事实来源**（含数据模型 §6 与 REST 契约 §7），后端实现需与之对齐，冲突必须显式修订 spec。
- `.scratch/knowledge-hub-mvp/issues/01~13` 为已完成工单；`CLAUDE.md` + `docs/agents/`（issue-tracker / domain）定义了 issue 跟踪与领域文档约定。

---

## 三、快速开始

```bash
# 1) 起后端依赖的中间件
cd knowledge-hub-backend
docker compose -f docker.compose.yml up -d

# 2) 准备后端 .env（模板见 .env.example）
cp .env.example .env
#    至少填一项：OPENAI_API_KEY（向量化/LLM/重排共用）
#    其余按需：TAVILY_SEARCH / MEM0_API_KEY / MINERU_API_TOKEN / LANGFUSE_*
pnpm install && pnpm run start:dev   # http://localhost:3000

# 3) 起前端
cd ../knowledge-hub-front
pnpm install && pnpm dev             # http://localhost:5173
```

演示账号：后端 seed 为 `admin` / `reviewer` / `user`（均 `123456`）；前端 Mock 为 `admin` / `li` / `qian` / `wang`（均 `123456`）。同名账号由**会话桥**镜像打通，真实登录态下 `/api` 端点组同样可用。

---

## 前后端联调现状

**联调已落地**，走**双通道混合模式**（ADR-0005）：前端在 `src/api/endpoint.ts` 用一张资源表决定每个资源走真实后端还是 MSW，差异全部消化在 `src/api/adapters/` 内，视图层签名零改动。

| 资源                                                                                   | 通道     | 说明                                                |
| -------------------------------------------------------------------------------------- | -------- | --------------------------------------------------- |
| `auth`                                                                                 | **real** | 登录 / 当前用户 / 权限码 / 单飞刷新双 Token         |
| `documents`                                                                            | **real** | CRUD + 上传 + 发布/审核，snake_case 由 adapter 消化 |
| `search`                                                                               | **real** | 全文检索 + 单文档命中高亮                           |
| `roles`                                                                                | **real** | 角色与权限树配置                                    |
| `graphs`                                                                               | **real** | 知识图谱全景 / 检索 / 节点 / 边                     |
| `ai`                                                                                   | **real** | Agent 会话与 SSE 流式对话                           |
| `folders` / `users` / `stats` / `categories` / `tags` / `announcements` / `operations` | mock     | 后端未实现，显式钉在 Mock 通道                      |

已经消化掉的系统性差异：**响应包装**（后端无外壳，`http.ts` 按通道决定是否拆包）、**路径单复数**（`REAL_ROOT` 重写表）、**字段命名**（`adapters/` 隔离 snake_case）、**双 Token 刷新**（`refresh.ts` 单飞 + 重放）。

尚未对齐的：`folders` / `users` / `stats` 等 7 个资源后端无对应接口；团队管理页走 `/team`，但成员与用户列表仍依赖 Mock 数据。

---

## 已知限制与 TODO

**后端**

- 无 Swagger/OpenAPI 文档，无请求限流，无 `@nestjs/terminus` 健康检查模块（仅 `GET /` 存活探针）。
- 消息消费失败仅记日志并 ack，**无死信队列与重试**。
- refresh Token 无服务端吊销机制，泄露窗口 = refresh 有效期（默认 7d）。
- 文档 CRUD 未做归属校验，`author_id` / `create_by` 取自请求体而非 Token（审核接口已正确使用 `@CurrentUser()`）；`kh_chunk` 召回侧已按可见性过滤，但写入侧字段可信度依赖调用方。
- 表结构靠 `init.sql` 维护，无迁移工具；改动需手工同步。
- 无应用自身 Dockerfile，无 CI 配置。

**前端**

- 7 个资源（folders / users / stats / categories / tags / announcements / operations）无后端实现，仍跑 Mock。
- 无测试框架，`msw` 仅作 Mock 服务器使用。
- 仅 PDF 与 Markdown 支持在线预览，office/txt 需下载。
- 无 i18n，无暗色主题。

---

## 相关文档

> 后端 `.trae/documents/` 下的设计文档为 `historical`（已完成工单的设计记录）——**改代码时以代码为准，不要照文档改代码**。

- `knowledge-hub-backend/README.md` —— 后端原 README（内容偏早期，**尚未覆盖 auth / kg / 审核流程 / AI 对话**，以本文件为准）
- `knowledge-hub-backend/CLAUDE.md` —— 后端 AI 约定补充（Langfuse 可观测、RAG 评测、本仓踩坑）
- `knowledge-hub-backend/.env.example` —— 环境变量完整清单
- `knowledge-hub-backend/.trae/documents/` —— 12 份模块设计文档（数据库映射、发布 RAG 管线、KG 管线、KG 检索 API、状态流转与审核、全文检索管线、全文检索过滤高亮、MinerU 上传解析、用户鉴权、邮箱验证与密码重置、团队模块、RAG 检索问答）
- `knowledge-hub-backend/doc/` —— 模块执行记录（`rbac-权限模块工单.md`）
- `knowledge-hub-front/docs/adr/` —— 前端架构决策记录（0001~0006）
- `knowledge-hub-front/.scratch/knowledge-hub-mvp/spec.md` —— MVP 需求与 REST 契约（唯一事实来源）