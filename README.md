# 企业级知识库系统（Knowledge Hub）

面向企业的文档知识管理平台，包含**前端 SPA（knowledge-hub-front）**与**后端服务（knowledge-hub-backend）**两个独立工程，目标是打通「文档上传 → 解析 → 索引 → 检索 → 知识图谱」的完整链路，并为二期 AI 问答提供数据底座。

> 当前状态：前端 MVP 已完整交付（基于 Mock 数据，13 个工单全部 done）；后端已完成文档、鉴权、检索、RAG 索引与知识图谱管线；**前后端尚未正式联调**，详见文末[前后端对接现状](#前后端对接现状)。

> **AI 编码工具（Claude Code / Codex / Cursor 等）请先读 [`AGENTS.md`](./AGENTS.md)** —— 那是给 AI 的薄地图。本文件是给人读的完整文档，篇幅较长，不必作为 AI 的入口。

---

## 目录结构

```
企业级知识库/
├── knowledge-hub-front/       # 前端：Vue 3 + Vite + Element Plus（SPA）
├── knowledge-hub-backend/     # 后端：NestJS + PG / Mongo / ES / Redis / Neo4j / RabbitMQ
├── backend-integration/       # 跨仓库联调层：spec.md（契约）+ issues/01~12（联调工单）
├── AGENTS.md                  # 给 AI 编码工具的项目地图（触发索引 + 硬约定）
├── 知识库项目评估报告.html      # 项目评估报告
└── 项目评估与学习路径.html      # 学习路径规划
```

> 另有 `.trae/`（早期计划文档）、`.claude/`（工具配置）、`.workbuddy/`（工作区数据 + 文档备份）三个隐藏目录。
```

两个子工程各自持有独立的 `.git` 仓库，需分别提交。

---

## 整体架构

```
                          ┌───────────────────────────┐
                          │   knowledge-hub-front     │
                          │  Vue3 / Pinia / Element+  │
                          │  MSW Mock（开发期默认开启） │
                          └─────────────┬─────────────┘
                                        │  /api/*  (axios)
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

**文档处理主链路**：上传文件 → RustFS 对象存储 → FileService 分发解析（txt/md 直读，其余走 MinerU）→ 正文写入 MongoDB、元数据写入 PostgreSQL → 发布触发 RabbitMQ 三类事件 → 分别构建 ES 全文索引、ES 向量分块、Neo4j 知识图谱。

---

## 一、后端 knowledge-hub-backend

### 技术栈

| 分类 | 选型 |
|---|---|
| 框架 / 语言 | NestJS 11 + TypeScript 5.7（`module: nodenext`, target ES2023） |
| 包管理 | pnpm |
| 关系库 | PostgreSQL 16（pgvector 镜像）+ TypeORM（`synchronize: false`） |
| 文档库 | MongoDB 7 + Mongoose（存 Markdown 正文） |
| 检索引擎 | Elasticsearch 8.17 + IK 中文分词（自建镜像） |
| 图数据库 | Neo4j（APOC）+ neo4j-driver |
| 缓存 | Redis 7（ioredis）——邮箱激活 Token、重置验证码 |
| 消息队列 | RabbitMQ 3.13（amqp-connection-manager） |
| 对象存储 | RustFS（S3 兼容，`@aws-sdk/client-s3`，forcePathStyle） |
| 文档解析 | mineru-open-sdk（cloud / flash / self-hosted 三通道） |
| AI / RAG | LangChain（`@langchain/openai`、`textsplitters`）+ zod 结构化输出 |
| 鉴权 | `@nestjs/jwt` + passport-jwt + bcryptjs（双 Token） |
| 邮件 | `@nestjs-modules/mailer` + nodemailer（SMTP） |
| 校验 | class-validator + class-transformer；zod 仅用于 LLM 输出 |
| ID 生成 | snowflake-id（应用侧生成，**统一以字符串传输**） |

### 目录结构（src/）

```
src/
├── main.ts               # 启动：全局 ValidationPipe(transform+whitelist)，端口 3000
├── app.module.ts         # 根模块：ConfigModule(global) / TypeORM / Mongoose 组装
├── app.controller.ts     # @Public() GET / 健康检查
├── auth/                 # 用户与鉴权
│   ├── auth.controller.ts / auth.service.ts / user.service.ts
│   ├── mail.service.ts / redis.service.ts
│   ├── decorators/       # @Public / @Roles / @CurrentUser
│   ├── guards/           # JwtAuthGuard（全局）/ RolesGuard（全局）
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
├── es/                   # @Global：es.service、doc-index.service(kh_document)
│                         #          vector-index.service(kh_chunk 向量索引)
├── pipeline/             # RAG 管线：chunker、embedding.service、
│                         #           pipeline.service(rag.queue 消费者)、
│                         #           search-index.service(search.queue 消费者)
├── kg/                   # 知识图谱：neo4j.service、extraction.service(LLM+zod)、
│                         #           kg.service(Cypher 构图)、kg-pipeline.service
├── search/               # SearchController：GET /search
├── rag/                  # RAG 检索问答：rag-search.service(混合检索 BM25+KNN→RRF→rerank)、
│                         #           rerank.service(精排)、ai-chat.service(/ai/chat SSE)、rag.controller
├── ai/                   # AI 对话 Agent：ai-agent.service(Agent 循环)、ai-session.service、
│                         #           mem0.service(长期记忆)、memory-cache.service(短期记忆)
└── common/utils/         # snowflake-id.util.ts
```

### 架构约定

- **分层**：Controller（薄）→ Service → 直接注入 `Repository<T>` / `Model<T>`，**没有额外 Repository 抽象层**。
- **全局守卫**：`JwtAuthGuard` + `RolesGuard` 注册为 `APP_GUARD`（`src/auth/auth.module.ts`）。**所有接口默认需要登录**，用 `@Public()` 放行；`@Roles('ROLE_X')` 做角色校验，不匹配返回 403。
- **无自定义拦截器 / 异常过滤器 / 响应包装器**：接口直接返回业务对象，没有统一 `{code, data, message}` 外壳。
- **DTO 校验**：class-validator 装饰器 + `@Type(() => Number)` 做查询串转数字；`UpdateDocumentDto` 用 `PartialType` 派生。
- **ID 规范**：雪花 ID 一律经 `normalizeSnowflakeId` 转字符串后再出参，避免 JS 大整数精度丢失。
- **Schema 管理**：**不使用 TypeORM migration**，表结构由 `init-scripts/postgresql/init.sql` 维护，`synchronize: false`（禁止开启）。
- **可选字段查询**：构造 TypeORM `where` 时必须显式判 `!== undefined`，不能用真值判断（`0` / `false` 是合法值）。

### 数据模型

**PostgreSQL（kh_ 前缀）**

| 表 | 说明 |
|---|---|
| `kh_document` | 文档元数据。`status`：0 草稿 / 1 已发布 / 2 待审核 / 3 已归档；含 `content_id`（指向 Mongo ObjectId）、分类、团队、标签、统计计数、逻辑删除 `deleted` |
| `kh_document_review` | 审核记录。`review_result`：NULL 待审 / 1 通过 / 2 驳回；含待审部分索引 |
| `kh_user` | 用户。bcrypt(cost 10)，`username` 带 `WHERE deleted = false` 的部分唯一索引 |
| `kh_role` | 角色。内置 `ROLE_ADMIN` / `ROLE_REVIEWER` / `ROLE_USER` |
| `kh_user_role` | 用户-角色关联，唯一约束 (user_id, role_id) |

初始脚本内置测试账号 `admin` / `reviewer` / `user`，密码均为 `123456`。

**MongoDB**：`document_content` 集合，存 Markdown 正文，含 `parse_state`（pending/running/success/failed）、`source_file_key`、`version`、`images[]`。

**Elasticsearch**

- `kh_document`：文档级快照，title/summary/content 使用 `ik_max_word` + `ik_smart`，`_id = docId` 幂等 upsert，检索走 `multi_match`（title 加权 2）。
- `kh_chunk`：RAG 分块，`embedding` 为 `dense_vector`（维度取 `EMBEDDING_DIMS`，默认 1024，cosine）。**目前只写不读**，尚无向量检索接口。

**Neo4j 图模型**：`(:Document)-[:HAS_CHUNK]->(:Chunk)-[:MENTIONS]->(:Entity)-[:RELATED_TO]->(:Entity)`

### 鉴权设计

- **注册**：`POST /auth/register` → 唯一性校验 → 雪花 ID + bcrypt → 绑定 `ROLE_USER`。当 `REQUIRE_EMAIL_VERIFICATION=true` 时写入 Redis 24h 激活 Token（`email:activation:<token>`）并发激活邮件；邮件失败会回滚用户记录。
- **登录**：`POST /auth/login` → 用户不存在/密码错误统一返回 401（防枚举）→ 邮箱未激活返回 403、账号禁用返回 403 → 签发**双 Token**。
- **双 Token**：access（`type: 'access'`，默认 2h）+ refresh（`type: 'refresh'`，默认 7d），HS256。刷新时校验类型并轮换两个 Token。**无服务端吊销/黑名单**，泄露窗口最长为 refresh 有效期。
- **JwtStrategy**：每次请求都会**回查数据库**构建 `request.user`，保证角色变更/禁用/删除即时生效；refresh Token 无法调用业务接口。
- **密码重置**：`POST /auth/password/send-code`（仅已验证账号，6 位随机码，Redis 10 分钟）→ `POST /auth/password/reset`（验证码一次性消费）。
- **邮件降级**：当 `MAIL_USER` 为空或为 `xx@xx.com` 时，激活链接/验证码直接打印到日志，本地开发无需配置 SMTP。

### API 一览

**无全局路由前缀**，服务地址 `http://localhost:3000`。除 `@Public()` 标注外，全部需要 `Authorization: Bearer <accessToken>`。

**`/auth`**

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/auth/register` | 注册（public） |
| GET | `/auth/verify-email?token=` | 邮箱激活，返回 HTML 页面（public） |
| POST | `/auth/resend-activation` | 重发激活邮件（public） |
| POST | `/auth/password/send-code` | 发送重置验证码（public） |
| POST | `/auth/password/reset` | 重置密码（public） |
| POST | `/auth/login` | 登录，返回双 Token（public） |
| POST | `/auth/refresh` | 刷新 Token（public） |
| GET | `/auth/me` | 当前用户信息 |
| GET | `/auth/reviewer-ids` | 审核人列表 |

**`/document`**

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/document/upload` | multipart 上传（字段 `file`），≤10MB，后台异步解析，返回 `poll_url` |
| POST | `/document` | 新建文档 |
| GET | `/document` | 分页列表，支持 id/title/category_id/team_id/author_id/tags/status/is_public 过滤 |
| GET | `/document/:id` | 详情（含正文与 parse_state） |
| PATCH | `/document/:id` | 局部更新（status 0→1 触发发布事件） |
| GET | `/document/reviews/pending/count` | 待审数量 |
| GET | `/document/reviews/pending` | 待审列表 |
| GET | `/document/:id/reviews` | 某文档审核记录 |
| POST | `/document/:id/approve` | 通过（`ROLE_REVIEWER` / `ROLE_ADMIN`） |
| POST | `/document/:id/reject` | 驳回，必填意见（同上角色） |
| POST | `/document/:id/publish` | 发布 |
| POST | `/document/:id/save-draft` | 存草稿 |
| POST | `/document/:id/archive` | 归档 |
| DELETE | `/document/:id` | 逻辑删除，同时清理 Mongo / ES / 图谱索引 |

**`/search`**：`GET /search?q=&page=&pageSize=`，ES 全文检索 `kh_document`，`q` 必填（1-100 字符），`pageSize` 上限 50。

> 路由顺序注意：`reviews/*` 必须声明在 `@Get(':id')` 之前。

### 异步消息拓扑

| Exchange | 类型 | 队列 | 路由键 | 消费者 |
|---|---|---|---|---|
| `document.events` | direct | `rag.queue` | `rag` | `PipelineService`（切片 + 向量化 → kh_chunk） |
| `document.events` | direct | `kg.queue` | `kg` | `KgPipelineService`（LLM 抽取实体关系 → Neo4j） |
| `kh.document.exchange` | topic | `kh.document.search.queue` | `document.index` | `SearchIndexService`（写 kh_document） |

手动 ack，`prefetch: 1`；消费者失败**仅记录日志并 ack**（无 DLQ、无重投，代码中已标 TODO）。发布事件为 best-effort，单个队列失败不影响其他队列。

### 环境变量（`.env`，已 gitignore，**仓库内无 `.env.example`**）

| 变量 | 用途 |
|---|---|
| `POSTGRES_HOST/PORT/USER/PASSWORD/DB` | PostgreSQL 连接（默认 localhost:5432，db `knowledge_hub`） |
| `MONGO_URI` | MongoDB 连接串 |
| `MINERU_PROVIDER` | `flash`(默认) / `cloud` / `self-hosted` |
| `MINERU_API_TOKEN` | MinerU 云端 Token |
| `MINERU_SELF_HOSTED_URL` / `MINERU_BACKEND` / `MINERU_TIMEOUT_MS` / `MINERU_MAX_RETRIES` | 自建解析通道配置 |
| `RUSTFS_ENDPOINT/ACCESS_KEY/SECRET_KEY/BUCKET` | 对象存储 |
| `OPENAI_API_KEY` | Embedding + LLM 密钥 |
| `EMBEDDING_BASE_URL` / `EMBEDDING_MODEL` | OpenAI 兼容端点（默认 DashScope 兼容模式） |
| `EMBEDDING_DIMS` | 向量维度，默认 1024 |
| `RAG_CHUNK_MAX_CHARS` | 分块最大字符数，默认 500（overlap 10%） |
| `LLM_MODEL` | 图谱抽取模型，默认 `qwen-plus` |
| `RABBITMQ_URL` | RabbitMQ 连接串 |
| `ES_NODE` | Elasticsearch 地址 |
| `NEO4J_URI` / `NEO4J_USER` / `NEO4J_PASSWORD` | Neo4j 连接 |
| `REDIS_HOST/PORT/PASSWORD/DB` | Redis 连接 |
| `REVIEW_ENABLED` | `false` 时发布直通，`true` 时走待审核流程 |
| `JWT_SECRET` / `JWT_ACCESS_EXPIRES`(2h) / `JWT_REFRESH_EXPIRES`(7d) | 鉴权 |
| `REQUIRE_EMAIL_VERIFICATION` / `APP_PUBLIC_URL` | 邮箱激活开关与激活链接前缀 |
| `MAIL_HOST/PORT/SECURE/USER/PASS/FROM` | SMTP（默认 smtp.qq.com:587） |
| `PORT` | 服务端口，默认 3000 |

### 依赖中间件（`docker.compose.yml`）

> 注意文件名是 `docker.compose.yml`，不是 `docker-compose.yml`。全部数据持久化到 `./volumes/`。

| 服务 | 镜像 | 端口 | 凭据 |
|---|---|---|---|
| postgres | pgvector/pgvector:pg16 | 5432 | user / 123456 |
| pgadmin | dpage/pgadmin4 | 8088→80 | admin@admin.com / admin |
| mongodb | mongo:7-jammy | 27017 | mongo_user / mongo_pass123 |
| mongo-express | mongo-express:1.0.2 | 8081 | me_admin / me_123456 |
| rabbitmq | rabbitmq:3.13-management | 5672 / 15672 | guest / guest |
| es | 本地构建（8.17.0 + IK） | 9200 | 安全已关闭 |
| kibana | kibana:8.17.0 | 5601 | — |
| rustfs | rustfs/rustfs:latest | 9000 / 9001 | rustfsadmin / rustfsadmin |
| neo4j | neo4j:latest + APOC | 7474 / 7687 | neo4j / 12345678 |
| redis | redis:7-alpine | 6379 | 无 |
| redisinsight | redis/redisinsight:2.50 | 5540 | — |

### 常用命令

```bash
cd knowledge-hub-backend

docker compose -f docker.compose.yml up -d   # 启动全部中间件
pnpm install
pnpm run start:dev                            # 开发（watch）
pnpm run build && pnpm run start:prod         # 生产
pnpm run lint                                 # ESLint（flat config）
pnpm test                                     # 单测
pnpm run test:e2e                             # e2e
```

测试覆盖较薄：4 个 spec 文件 + 1 个 e2e 骨架；真实接口测试用例沉淀在 `test/curl/`（curl 集合 + PowerShell 脚本）。

---

## 二、前端 knowledge-hub-front

### 技术栈

| 分类 | 选型 |
|---|---|
| 框架 | Vue 3.5（Composition API，`<script setup lang="ts">`） |
| 构建 | Vite 6 + TypeScript 5.7（strict + `noUnusedLocals/Parameters`） |
| UI 库 | Element Plus 2.9（图标全局注册） |
| 状态管理 | Pinia 3 |
| 路由 | vue-router 4（history 模式） |
| HTTP | axios 1.20 |
| 富文本 | TipTap 2.27（starter-kit + image + table） |
| 图表 | ECharts 6（按需 `echarts.use([...])` 摇树） |
| Mock | MSW 2.15（Service Worker 拦截，接口全覆盖） |
| 样式 | 原生 scoped CSS + 全局 `styles/index.css`，覆盖 Element Plus CSS 变量（主色 `#1a66ff`） |
| 规范 | ESLint 9 flat config + Prettier（无分号 / 单引号 / printWidth 100） |

### 目录结构（src/）

```
src/
├── api/          # 每个资源一个模块（13 个）+ http.ts 统一请求封装
├── components/
│   ├── charts/   # VChart.vue（ECharts 包装）
│   └── editor/   # RichEditor.vue（TipTap 包装）、json.ts
├── layouts/      # MainLayout.vue（顶栏 + 横向菜单）
├── mocks/        # MSW：browser / db（内存数据库）/ seed / parse / handlers/
├── router/       # 路由表 + 全局前置守卫
├── stores/       # user.ts（唯一 Pinia store）
├── styles/       # index.css
├── types/        # api.ts（完整领域契约）
└── views/        # login / dashboard / documents / search / ai-qa /
                  # knowledge-graph / profile / admin
```

### 路由

| 路径 | 名称 | 功能 |
|---|---|---|
| `/login` | login | 登录（独立布局，`public: true`） |
| `/` | — | 重定向到 `/dashboard` |
| `/dashboard` | dashboard | 首页大盘：统计卡片 + 趋势折线 + 分类环形 + 最近操作 |
| `/documents` | documents | 文档管理（核心页）：四分区 + 目录树 + 列表/卡片 |
| `/documents/:id/edit` | document-editor | TipTap 在线编辑 |
| `/documents/:id/preview` | document-preview | 文档预览 / 下载 |
| `/search` | search | 智能搜索（高亮、热门、历史、高级筛选） |
| `/ai-qa` | ai-qa | AI 智能问答（**二期占位页**） |
| `/knowledge-graph` | knowledge-graph | 知识图谱（**二期占位页**） |
| `/profile` | profile | 个人中心 |
| `/admin` | admin | 系统管理 - 用户管理（`requiresAdmin: true`） |

全局守卫逻辑：有 Token 但 store 为空时先 `restoreSession()` → 已登录访问 public 页跳 `/dashboard` → 未登录跳 `/login?redirect=<fullPath>` → `requiresAdmin` 不满足则提示并回 `/dashboard`。

### 状态管理

只有一个 store `src/stores/user.ts`：持有 `user`，派生 `isLoggedIn` / `isAdmin` / `roleLabel`，动作 `login` / `restoreSession`（用单飞 Promise 避免并发重复请求 `/auth/me`）/ `logout` / `setUser`。

Token 不在 store 内，由 `src/api/http.ts` 管理，持久化在 `localStorage` 的 `kh_token`。

### 请求层

`src/api/http.ts`：`axios.create({ baseURL: '/api', timeout: 15000 })`

- 请求拦截：有 Token 时加 `Authorization: Bearer <token>`
- 响应拦截：HTTP 401 → 清 Token 并跳登录（动态 `import('@/router')` 打断循环依赖）；其他错误抛 `ApiError`
- `request<T>()` 负责拆包 `{ code, data, message }`，`code !== 0` 抛错

**未配置 Vite 代理**，`vite.config.ts` 只有 `plugins` / `@` 别名 / `server.port: 5173`。

### Mock 策略（重要）

开发期默认启用 MSW，**前端所有页面均跑在 Mock 数据上**：

- `src/mocks/db.ts` 是模块级单例内存库，权限与筛选全部实现为纯函数：`canSeeDocument`（admin 全见 / 本人可见 / company 全员可见 / department 同部门可见，不可见即**完全隐藏**而非置灰）、`canManageDocument`、`inZone`、`filterDocuments`、`paginate`、`relevanceScore`。
- `src/mocks/seed.ts` 提供与原型对齐的演示数据；演示账号 `admin` / `li` / `qian` / `wang`，密码均为 `123456`。
- `src/mocks/parse.ts` 模拟解析流程 pending → processing(2-4s) → 90% done / 10% failed。
- `main.ts` 中 **`await worker.start()` 早于 `app.use(router)`**，避免首个守卫的 `/auth/me` 被绕过。
- 关闭 Mock 接真实后端：设置 `VITE_ENABLE_MOCK=false`（生产构建由 `import.meta.env.DEV` 兜底，永不启用 Mock）。

**项目没有任何 `.env*` 文件**，仅消费 `VITE_ENABLE_MOCK`、`BASE_URL`、`DEV` 三个变量。

### 文档能力细节

- **文档管理页**：四分区（我的 / 公开 / 部门 / 归档）、目录树、300ms 防抖搜索、列表⇄卡片切换、排序、行内与批量操作（删除/归档/恢复/移动）、解析状态 **2s 轮询**。
- **在线编辑**：1.5s 防抖自动保存，`saved/dirty/saving` 三态、保存合并、失败重试、`beforeunload` 用 `fetch(keepalive: true)` 兜底、路由离开前等待在途保存。
- **预览**：PDF 用原生 `iframe` 加载 blob URL（iframe 首次导航不受 Service Worker 控制，故不能用 mock 路由直接给 URL）；在线文档只读复用 `RichEditor`；office/md/txt 提示下载查看。

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

- `docs/adr/` 记录了 6 条架构决策：0001 技术选型、0002 混合内容模型、0003 Mock 优先与接口隔离、0004 AI/图谱延后至二期但一期先落 `parseStatus`、0005 联调双通道混合模式、0006 Markdown 正文渲染。
- `.scratch/knowledge-hub-mvp/spec.md` 是 MVP 的**唯一事实来源**（含数据模型 §6 与 REST 契约 §7），后端实现需与之对齐，冲突必须显式修订 spec。
- `.scratch/knowledge-hub-mvp/issues/01~13` 为已完成工单；`CLAUDE.md` + `docs/agents/` 定义了 issue 跟踪与领域文档约定。

---

## 三、快速开始

```bash
# 1) 起后端依赖的中间件
cd knowledge-hub-backend
docker compose -f docker.compose.yml up -d

# 2) 准备后端 .env（参考上方环境变量表，仓库内无 .env.example）
#    关键项：POSTGRES_* / MONGO_URI / RABBITMQ_URL / ES_NODE / REDIS_* / NEO4J_* / JWT_SECRET / OPENAI_API_KEY
pnpm install && pnpm run start:dev   # http://localhost:3000

# 3) 起前端
cd ../knowledge-hub-front
pnpm install && pnpm dev             # http://localhost:5173（默认 Mock 数据）
```

---

## 前后端对接现状

**两端目前是并行开发、尚未联调的**。前端跑在 MSW Mock 上，后端接口形态与前端约定存在系统性差异，正式对接前需要先做契约对齐：

| 维度 | 前端约定 | 后端现状 |
|---|---|---|
| 基础路径 | `baseURL: '/api'` | **无全局前缀**，路由直接挂在 `/`；Vite 也未配代理 |
| 响应结构 | 统一 `{ code, data, message }`，`code === 0` 为成功 | **无响应包装**，直接返回业务对象 |
| 资源命名 | `/documents`、`/folders`、`/users`、`/stats`、`/categories`、`/tags`、`/announcements`、`/operations` | 仅有 `/auth`、`/document`（单数）、`/search` |
| 上传 | `POST /documents/upload`，`files` + `meta`(JSON) | `POST /document/upload`，单文件字段 `file` |
| 字段命名 | `parseStatus` / `visibility` / `fileType` / `ownerId` | `parse_state` / `is_public` / 状态码 `status` / `author_id` |
| 鉴权 | `Bearer` + `localStorage.kh_token` | `Bearer` 双 Token（access/refresh），但**前端没有 refresh 逻辑** |
| 权限 | 前端纯函数模拟（角色 + 部门可见性） | 后端仅 `ROLE_*` 角色控制，**无部门/多租户隔离**，文档 CRUD 未做归属校验 |

已可复用的部分：登录、`GET /auth/me`、`GET /search` 三者的语义基本一致，改造量主要集中在**响应包装、字段映射、上传协议与刷新 Token**四块。

> 建议后端先补一个全局响应拦截器 + `setGlobalPrefix('api')`，再逐模块对齐字段名；或在前端 `http.ts` 中做适配层，避免大范围改动视图代码。

---

## 已知限制与 TODO

**后端**

- 无 Swagger/OpenAPI 文档，无请求限流，无健康检查模块（`@nestjs/terminus`）。
- 消息消费失败仅记日志并 ack，**无死信队列与重试**。
- `kh_chunk` 向量索引**只写不读**，尚无向量检索接口；**没有问答/对话接口**，RAG 链路止步于索引。
- refresh Token 无服务端吊销机制。
- 文档 CRUD 未做归属与角色校验，`author_id` / `create_by` 取自请求体而非 Token（审核接口已正确使用 `@CurrentUser()`）。
- 表结构靠 `init.sql` 维护，无迁移工具；改动需手工同步。
- 无应用自身 Dockerfile，无 CI 配置。

**前端**

- AI 问答与知识图谱为占位页（二期）。
- 无 SSE / WebSocket / 流式能力，无 Markdown 渲染库，无 i18n，无暗色主题。
- 无测试框架，`msw` 仅作 Mock 服务器使用。
- 仅 PDF 支持在线预览，office/md/txt 需下载。

---

## 相关文档

> 以下文档头部均带 `status` frontmatter（`current` = 契约与决策 / `evolving` = 进行中 / `historical` = 已完成的设计记录）。完整状态地图见 [`AGENTS.md`](./AGENTS.md) 第 4 节。

- `knowledge-hub-backend/README.md` —— 后端原 README（内容偏早期，**尚未覆盖 auth / kg / 审核流程**，以本文件为准）
- `knowledge-hub-backend/.trae/documents/` —— 12 份模块设计文档（数据库映射、发布 RAG 管线、KG 管线、KG 检索 API、状态流转与审核、全文检索管线、全文检索过滤高亮、MinerU 上传解析、用户鉴权、邮箱验证与密码重置、团队模块、RAG 检索问答）
- `knowledge-hub-backend/doc/` —— 模块执行记录（`rbac-权限模块工单.md` 为 `current`，其余为历史记录）
- `backend-integration/` —— **前后端联调工单**（spec.md + issues/01~12）：双通道混合模式、字段映射总表、待后端清单、验收口径。01~05 已交付；06~12 仍在推进（角色权限、KG 全景页、可见性 ACL、Agentic RAG、Graph RAG）
- `knowledge-hub-front/docs/adr/` —— 前端架构决策记录
- `knowledge-hub-front/.scratch/knowledge-hub-mvp/spec.md` —— MVP 需求与 REST 契约（唯一事实来源）
- `知识库项目评估报告.html` / `项目评估与学习路径.html` —— 评估报告与学习路径
