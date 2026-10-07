# Knowledge Hub Backend

企业级知识库后端服务，基于 NestJS 构建的文档管理 + 检索平台：支持文档上传、AI 解析、全文检索与 RAG 向量检索。

## 技术栈

| 层次       | 技术                                                                                             |
| ---------- | ------------------------------------------------------------------------------------------------ |
| 框架       | NestJS 11 + TypeScript                                                                           |
| 元数据存储 | PostgreSQL 16（TypeORM，表结构由 `init-scripts/postgresql/init.sql` 管理，`synchronize: false`） |
| 正文存储   | MongoDB 7（Mongoose，存 Markdown 解析结果）                                                      |
| 全文检索   | Elasticsearch 8.17（IK 中文分词，索引 `kh_document`）                                            |
| 向量检索   | Elasticsearch 索引 `kh_chunk`（dense_vector 1024 维 cosine）                                     |
| 消息队列   | RabbitMQ 3.13（amqp-connection-manager，`@Global` 的 `src/mq` 封装）                             |
| 对象存储   | RustFS（S3 兼容，存原始上传文件）                                                                |
| 文档解析   | [MinerU](https://github.com/opendatalab/MinerU)（pdf/docx/pptx/xlsx → Markdown）                 |
| 向量化     | LangChain + OpenAI 兼容接口（默认 DashScope，`EMBEDDING_DIMS=1024`）                             |

## 架构与数据流

```
上传文件（POST /document/upload）
        │
        ▼
┌─────────────────────────────────────────────────┐
│ DocumentService                                  │
│  1. 原文件存 RustFS                               │
│  2. FileService 分发解析：txt/md 直读；            │
│     pdf/docx/pptx/xlsx 交 MinerU 出 Markdown      │
│  3. PG 存元数据（Snowflake ID，字符串防精度丢失）    │
│     Mongo 存正文（content_id 关联）                │
└─────────────────────────────────────────────────┘
        │ 发布（POST /document/:id/publish 或 PATCH status 0→1）
        ▼
┌─────────────────────────────────────────────────┐
│ RabbitMQ 拓扑                                     │
│  document.events (direct) ──► rag.queue ─► RAG 管线 │
│                           └─► kg.queue ─► KG（规划中）│
│  kh.document.exchange (topic) ─► kh.document.search.queue │
│        routing key: document.index                │
└─────────────────────────────────────────────────┘
        │
        ├──► SearchIndexService：消费完整快照（PG 元数据 + Mongo 正文），
        │     直接写 ES `kh_document`（_id=docId 幂等 upsert）
        └──► PipelineService：查 Mongo 正文 → LangChain Markdown 分块
              → 向量化 → 写 ES `kh_chunk`（先 delete_by_query 再 bulk，幂等）
```

删除文档（`DELETE /document/:id`）为逻辑删除，并同步清理 ES 两个索引（`delete_by_query` + `refresh: true`），失败仅记录错误日志不阻塞删除。

## 目录结构

```
src/
├── document/        # 文档 CRUD、上传、发布（PG 元数据 + Mongo 正文）
│   ├── entities/    #   TypeORM 实体
│   └── schemas/     #   Mongoose Schema（document_content）
├── file/            # 解析分发器：txt/md 直读，其余交 MinerU
├── mineru/          # MinerU SDK 封装（cloud / flash / self-hosted 三通道）
├── storage/         # RustFS S3 客户端
├── mq/              # RabbitMQ 封装（@Global，负责重连/ack/拓扑声明）
├── pipeline/        # RAG 管线：消费 rag.queue → 分块 → 向量化 → ES
├── search/          # GET /search 全文检索接口
├── es/              # ES 客户端、kh_document / kh_chunk 索引服务
└── common/utils/    # Snowflake ID 工具
```

## 快速开始

### 1. 启动基础设施

```bash
# 注意 compose 文件名为 docker.compose.yml
docker compose -f docker.compose.yml up -d
```

启动的服务与端口：

| 服务          | 端口         | 说明                                       |
| ------------- | ------------ | ------------------------------------------ |
| PostgreSQL    | 5432         | 元数据；初始化脚本仅首次启动执行           |
| pgAdmin       | 8088         | admin@admin.com / admin                    |
| MongoDB       | 27017        | 正文存储                                   |
| mongo-express | 8081         | me_admin / me_123456                       |
| RabbitMQ      | 5672 / 15672 | AMQP / 管理 UI（guest/guest）              |
| Elasticsearch | 9200         | 本地 Dockerfile 构建内置 IK 分词           |
| Kibana        | 5601         | ES 控制台                                  |
| RustFS        | 9000 / 9001  | S3 API / 控制台（rustfsadmin/rustfsadmin） |
| Neo4j         | 7474 / 7687  | 知识图谱存储（预留，bolt: neo4j/12345678） |

数据落在 `./volumes/` 下（bind mount）。如需重置 PostgreSQL，需手动删除 `volumes/postgres` 目录。

### 2. 配置环境变量

复制 `.env`（仓库已含开发用默认值）并核对：

```env
# 数据库
POSTGRES_HOST=localhost
POSTGRES_PORT=5432
POSTGRES_USER=user
POSTGRES_PASSWORD=123456
POSTGRES_DB=knowledge_hub
MONGO_URI=mongodb://mongo_user:mongo_pass123@localhost:27017/knowledge_hub?authSource=admin

# MinerU 解析通道：cloud（精准，需 Token）/ flash（轻量，≤10MB/20页）/ self-hosted
MINERU_PROVIDER=flash
MINERU_API_TOKEN=

# 对象存储
RUSTFS_ENDPOINT=http://localhost:9000
RUSTFS_ACCESS_KEY=rustfsadmin
RUSTFS_SECRET_KEY=rustfsadmin
RUSTFS_BUCKET=knowledge-hub

# 向量化（OpenAI 兼容接口）
OPENAI_API_KEY=<your-key>
EMBEDDING_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1
EMBEDDING_MODEL=qwen3.7-text-embedding-flash
EMBEDDING_DIMS=1024

# 消息队列 / 检索
RABBITMQ_URL=amqp://guest:guest@localhost:5672
ES_NODE=http://localhost:9200
RAG_CHUNK_MAX_CHARS=500
```

### 3. 安装依赖并启动

```bash
pnpm install

# 开发模式（watch）
pnpm run start:dev

# 生产模式
pnpm run build && pnpm run start:prod
```

服务默认监听 `http://localhost:3000`（`PORT` 可覆盖）。

## API 接口

| 方法   | 路径                    | 说明                                                             |
| ------ | ----------------------- | ---------------------------------------------------------------- |
| POST   | `/document/upload`      | 上传文件并异步解析，返回草稿摘要（前端轮询 `GET /document/:id`） |
| POST   | `/document`             | 创建文档                                                         |
| GET    | `/document`             | 分页查询文档列表                                                 |
| GET    | `/document/:id`         | 查询文档详情（含解析状态）                                       |
| PATCH  | `/document/:id`         | 更新元数据（status 0→1 触发发布流程）                            |
| POST   | `/document/:id/publish` | 发布文档：投递 rag/kg 队列 + Search 快照索引消息                 |
| DELETE | `/document/:id`         | 逻辑删除 + ES 索引清理                                           |
| GET    | `/search?q=`            | 全文检索（multi_match title^2/summary/content，IK 分词）         |

### 上传示例

```bash
curl -X POST http://localhost:3000/document/upload \
  -F "file=@./sample.pdf" \
  -F "title=示例文档" \
  -F "author_id=1001"
```

- 支持格式：`pdf`、`docx`、`pptx`、`xlsx`、`txt`、`md`；大小限制 ≤10MB（对齐 MinerU flash 通道）
- 中文文件名请使用 UTF-8 编码传输（推荐 Git Bash / WSL / Postman；Windows cmd 的 curl.exe 会以 GBK 发送导致乱码）

### 检索示例

```bash
curl "http://localhost:3000/search?q=前端技术栈&page=1&pageSize=10"
```

## 测试

```bash
# 单元测试
pnpm run test

# e2e 测试
pnpm run test:e2e

# 覆盖率
pnpm run test:cov
```

## 开发注意事项

- **表结构**：由 `init-scripts/postgresql/init.sql` 管理，实体改动需同步修改 SQL，禁止开启 `synchronize`
- **Snowflake ID**：所有 ID 字段以字符串存储/传输（超出 JS Number 安全整数范围），跨层使用 `normalizeSnowflakeId` 归一化
- **TypeORM 条件**：可选 DTO 字段拼 `where` 时须显式 `!== undefined` 判断
- **MinerU flash 通道**：≤10MB、≤20 页，且数据会出境；敏感文档请切换 self-hosted 通道
- **消息拓扑变更**：旧队列不会自动删除，需到 RabbitMQ 管理 UI（`:15672`）手动清理（如 phase-1 的 `search.queue`）
- **可观测性**：文档相关日志统一携带 `docId`，便于跨服务追踪
