# CLAUDE.md — knowledge-hub-backend

> 面向 AI 助手的后端约定补充。项目总览与模块地图见**工作区根目录** `AGENTS.md`（根目录不是 git 仓库，本文件只覆盖本仓）。
> Langfuse 可观测与 RAG 评测的完整设计与执行记录见 `../backend-integration/issues/13-langfuse-eval.md`（同样在根工作区，不在本仓）。

## Langfuse 可观测（工单 13）

### 现状
tracing 已接入，**默认开启，走云端** `https://cloud.langfuse.com`。所有 LLM 链路（Agent 循环 / 意图路由 / 切题评估 / 检索 / 图谱 / 记忆 / suggestions）都在一个 trace 里，`userId` = 登录用户、`sessionId` = AI 会话 id。

### 环境变量（`.env`，该文件被 gitignore）
| 变量                                          | 说明                                                                    |
| --------------------------------------------- | ----------------------------------------------------------------------- |
| `LANGFUSE_ENABLED`                            | `false` 一键关闭 tracing；关闭后主链路行为与未接入时完全一致            |
| `LANGFUSE_PUBLIC_KEY` / `LANGFUSE_SECRET_KEY` | 云项目 API Key                                                          |
| `LANGFUSE_BASE_URL`                           | 云端 `https://cloud.langfuse.com`；本地自托管填 `http://localhost:3100` |

### 代码位置与硬约定
- 引导：[src/observability/tracing.ts](src/observability/tracing.ts) `initTracing()`；由 [src/main.ts](src/main.ts) 在 **`.env` 加载之后、`NestFactory.create` 之前**调用（`import 'dotenv/config'` 必须是 main.ts 第一行，否则 Langfuse 拿到空凭据）
- 服务：[src/observability/tracing.service.ts](src/observability/tracing.service.ts) —— `runChat`（把一次对话包成 agent trace）/ `withRetriever` / `withEmbedding` / `withSpan`；`@Global` 模块 `observability.module.ts`
- **降级不报错**：初始化失败、span 写入失败、flush 失败一律只记日志，不抛错、不影响业务返回。新增 tracing 代码必须遵守这条
- **trace 级属性写入方式**：v4 的 trace 属性取自「根观察」，因此 `userId` / `sessionId` 是通过 `LangfuseOtelSpanAttributes.TRACE_USER_ID / TRACE_SESSION_ID` **直接写在根 span 上**（`CallbackHandler({userId,sessionId})` 构造参数不会生效，别再用那个写法）
- LLM 回调经 `AsyncLocalStorage` 传递（`tracing.current()`），所以 `buildModel` / `buildUtilityModel` / `generateSuggestions` 里直接读即可，无需逐层传参
- `data-retrieve` 事件的 item 同时带 `excerpt`（120 字，前端卡片显示用）和 **`content`（完整 chunk，评测/详情用）**。给 judge 或任何"判断回答是否忠于原文"的消费方，必须用 `content`

### 本地自托管（可选，内存代价大）
`docker-compose.langfuse.yml` 是官方 v4 栈的本地化版（web 映射 **3100**、移除 postgres/redis/clickhouse 宿主端口）。敏感取值走 `${LF_*}` 插值且**全部带 `:-` 默认值**。
**插值变量必须保持 `LF_` 前缀，不要改回通用名** —— 本文件与后端 `.env` 同目录，Compose 会自动加载它做插值；早期用 `POSTGRES_USER/POSTGRES_PASSWORD/POSTGRES_DB/REDIS_HOST` 时被 `.env` 的值（user/123456/knowledge_hub/localhost）灌进 Langfuse 栈，Postgres 以错误凭据初始化 → Prisma P1000。加前缀后 `.env` 中不存在同前缀键，污染路径被切断（已用 `docker compose config` 实测确认）。真实 Langfuse Key 不要写回本文件，用 `--env-file docker-compose.langfuse.env`（已 gitignore）或环境变量注入。
实测该栈占 ~2.9 GB，本机内存紧张时优先用云端；`down`（不加 `-v`）会保留数据卷，可随时切回。

### 读取 trace（v4 已下线旧端点）
Langfuse v4 是 `events_only` 模式，`/api/public/traces` 与 `/api/public/observations` **不可用**。改用：
- 观察：`GET {BASE_URL}/api/public/v2/observations?fields=core,basic,usage,model&traceId=<id>`
- 分数：`GET {BASE_URL}/api/public/v3/scores?traceId=<id>` / `?name=<k1,k2>`
- 认证：`Authorization: Basic base64(publicKey:secretKey)`

## RAG 评测

```bash
pnpm run eval:seed   # 上传并发布评测语料 → 生成 test/eval/corpus-manifest.json（标题→运行时 doc_id）
pnpm run eval        # 逐条 HTTP SSE 跑真实对话 → 八指标 → 回写 Langfuse → 出 eval-report.md
```

- 数据集事实源：[test/eval/dataset.json](test/eval/dataset.json)；实测语料与清单由 seed 脚本生成
- **ground truth 用文档标题而非 doc_id**：雪花 id 每次上传都变，跨环境不可移植
- 常用环境变量：`EVAL_ONLY=qa-001,qa-013`（只跑指定用例）、`EVAL_SKIP_JUDGE=1`（跳过生成层 judge）、`EVAL_RUN_NAME=<name>`、`EVAL_BASE_URL`（默认 `http://localhost:3000`）
- 产物 `corpus-manifest.json` / `eval-report.md` **含本机数据库的 doc_id，已 gitignore，不要提交**
- runner 会把数据集同步为 Langfuse dataset（`ensureDataset()` 负责先建集，`dataset.createItem` 不会自动建集，缺集会 404）

## 本仓踩坑（务必先读）

1. **不要跑 `pnpm run lint`**：它带 `eslint --fix` + prettier，会按与现有代码风格不一致的配置重排大量无关文件（实测一次改 63 个文件）。校验用 `pnpm run build` + `pnpm test`。该仓库 lint 本身当前也不通过（约 171 项既有类型解析报错）。
2. **`src/storage/rustfs.service.ts` 的 `onModuleInit` 缺兜底**：`HeadBucketCommand` 失败后走 catch，而 `CreateBucketCommand` 没有 try/catch —— RustFS 未就绪时会抛未捕获异常让整个进程 `exit 1`。排障时若看到 `TimeoutError: socket hang up`（`$metadata.attempts`）即为此，可 `docker restart knowledge_hub_rustfs` 临时恢复。
3. **启动慢 ≠ 卡死**：本机内存紧张时（Docker 的 WSL2 虚拟机可占 ~5 GB 且不归还宿主），Node 同步加载依赖图会因缺页抖动拖到 3~4 分钟，期间**没有任何日志输出**（事件循环被阻塞）。先看 `Pages Input/sec` 与可用内存，不要误判成死锁。
4. Docker/WSL 维护顺序：**先 `docker desktop stop`，再 `wsl --shutdown`，最后启动 Docker Desktop**。在 Docker 运行时直接 `wsl --shutdown` 会破坏宿主→容器端口转发（TCP 能连、握手被空响应/ECONNRESET）；Docker 重启后部分容器（rabbitmq/redis/rustfs/neo4j）可能不自启，需 `docker start` 补起。