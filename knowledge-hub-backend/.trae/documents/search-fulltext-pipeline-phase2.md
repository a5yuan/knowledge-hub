---
status: historical
updated: 2026-09-14
---

# 二期工单：全文检索（Search）链路 —— kh_document 快照索引 + 检索 API

> 依据架构图《全文检索（Search）流程》制定：发布端构建文档快照 → topic 交换机 → Search 消费者 → ES 索引 kh_document。
> 一期工单见 [document-publish-rag-pipeline.md](file:///d:/桌面/AI项目/企业级知识库/knowledge-hub-backend/.trae/documents/document-publish-rag-pipeline.md)（RAG 链路已上线）。

## Summary

按架构图落地 Search 全文检索链路（消息体为**整篇快照：元数据 + 正文**，与 RAG 的 docId 查库模式不同）：

```
发布成功（publish 接口 / PATCH status 0→1）
  → 发布端: 查 PG 元数据 + Mongo 正文 → 构建文档快照（整篇元数据 + 正文）
  → mq模块: 投递到 topic 交换机 kh.document.exchange（routing key: document.index）
  → 队列 kh.document.search.queue
  → pipeline模块: SearchIndexService 消费 → 创建/更新 ES 文档索引 kh_document（_id=docId 幂等）
检索: GET /search?q= 对 kh_document 的 title/summary/content 做中文关键词检索（ik 分词）
```

用户已确认两项决策：
1. **移除旧 search 投递链路**：`document.events`（direct）收敛为 rag/kg 两队列，Search 改走新 topic 交换机（不混合两套模式）。
2. **包含检索 API**：新增最小 `GET /search?q=` 接口（超出图示范围，用户明确要求）。

## Current State Analysis

- [mq.service.ts](file:///d:/桌面/AI项目/企业级知识库/knowledge-hub-backend/src/mq/mq.service.ts)：direct 交换机 `document.events` + 三队列（search/rag/kg），`ROUTING_KEYS = ['search','rag','kg']`，`publish()` 类型锁定 `RoutingKey`，payload 固定 `DocumentPublishPayload`
- [document.service.ts](file:///d:/桌面/AI项目/企业级知识库/knowledge-hub-backend/src/document/document.service.ts)：`publish()`/`update()` 0→1 时 `dispatchPublish()` 向三 routing key 投递 `{docId,title,publishedAt}`；已注入 `contentModel`（可直接查 Mongo 正文）；`remove()` 有 kh_chunk 清理 TODO
- [pipeline.service.ts](file:///d:/桌面/AI项目/企业级知识库/knowledge-hub-backend/src/pipeline/pipeline.service.ts)：RAG 消费者（监听 rag.queue），消费→分块→向量化→写 kh_chunk，保持不动
- [es/vector-index.service.ts](file:///d:/桌面/AI项目/企业级知识库/knowledge-hub-backend/src/es/es/vector-index.service.ts)：kh_chunk 索引管理，lazy ensureIndex + 先删后写幂等模式（新 DocIndexService 复用该模式）
- [document.entity.ts](file:///d:/桌面/AI项目/企业级知识库/knowledge-hub-backend/src/document/entities/document.entity.ts)：快照元数据来源（title/summary/tags/author_id/category_id/team_id/status/is_public/word_count/publish_time）
- [document-content.schema.ts](file:///d:/桌面/AI项目/企业级知识库/knowledge-hub-backend/src/document/schemas/document-content.schema.ts)：`content`（整篇 markdown 正文）为快照正文来源
- ES 8.17 + IK 分词已就绪（docker.compose.yml），`@elastic/elasticsearch` 客户端已装（一期）
- 检索 API 无现成落点：document.controller 是文档 CRUD 域，Search 查询应独立成模块

## Proposed Changes

### 1. 修改 `src/mq/mq.service.ts`（拓扑调整 + 新 topic 交换机）

- 常量变更：
  - `ROUTING_KEYS = ['rag', 'kg'] as const`（移除 `'search'`），删除 `QUEUE_SEARCH` 常量与 `search.queue` 声明/绑定代码，删除对应 TODO 注释（本期已实现）
  - 新增：
    ```ts
    export const SEARCH_EXCHANGE = 'kh.document.exchange';   // topic 类型
    export const QUEUE_DOC_SEARCH = 'kh.document.search.queue';
    export const ROUTING_KEY_DOC_INDEX = 'document.index';
    ```
- `onModuleInit` setup 追加：`assertExchange(SEARCH_EXCHANGE, 'topic', { durable: true })` → `assertQueue(QUEUE_DOC_SEARCH, { durable: true })` → `bindQueue(QUEUE_DOC_SEARCH, SEARCH_EXCHANGE, ROUTING_KEY_DOC_INDEX)`
- 新增 `DocumentIndexPayload` 接口（整篇快照）：
  ```ts
  export interface DocumentIndexPayload {
    docId: string;
    title: string;
    summary: string | null;
    content: string;            // 整篇 markdown 正文
    tags: string | null;
    authorId: string | null;
    categoryId: string | null;
    teamId: string | null;
    status: number;
    isPublic: boolean;
    wordCount: number;
    publishTime: string | null; // ISO
    publishedAt: string;        // ISO，索引时间
  }
  ```
- `publish()` 签名放宽：`publish(routingKey: string, payload: DocumentPublishPayload | DocumentIndexPayload)`（保留持久化 + json 通道编码不变）

### 2. 修改 `src/document/document.service.ts`（快照构建 + 双投递）

- `dispatchPublish(docId, title)`：循环改为 `ROUTING_KEYS`（现 rag/kg），注释更新为「RAG/KG 两队列」
- 新增 `private async dispatchIndex(doc: KhDocument): Promise<void>`：
  1. 查 Mongo：`contentModel.findOne({ documentId: doc.id, deleted: false })` → `content = c?.content ?? ''`
  2. 构建快照 `DocumentIndexPayload`（PG 元数据 + 正文，`publishTime`/`publishedAt` 转 ISO）
  3. `mq.publish(ROUTING_KEY_DOC_INDEX, snapshot)`；try/catch + `logger.error`（含 docId），失败不阻断发布（与 dispatchPublish 同策略）
- `publish()` 与 `update()` 的 0→1 跳变处：`dispatchPublish` 之后追加 `await/void this.dispatchIndex(doc)`（update 处沿用现有 `void` 风格）
- `publish()` 返回值：`queues: [...ROUTING_KEYS]`（现 `['rag','kg']`）+ 追加 `indexExchange: SEARCH_EXCHANGE` 字段，便于测试核对
- `remove()` 的 TODO 注释扩展为同时清理 kh_chunk 与 kh_document 两索引（本期仍不实现）

### 3. 新建 `src/es/doc-index.service.ts`（kh_document 索引管理）

复用 VectorIndexService 的 lazy ensureIndex 模式：

- `DOC_INDEX = 'kh_document'`
- `ensureIndex()`（幂等）映射：
  ```json
  {
    "doc_id":     { "type": "keyword" },
    "title":      { "type": "text", "analyzer": "ik_max_word", "search_analyzer": "ik_smart" },
    "summary":    { "type": "text", "analyzer": "ik_max_word", "search_analyzer": "ik_smart" },
    "content":    { "type": "text", "analyzer": "ik_max_word", "search_analyzer": "ik_smart" },
    "tags":       { "type": "keyword" },
    "author_id":  { "type": "keyword" },
    "category_id":{ "type": "keyword" },
    "team_id":    { "type": "keyword" },
    "status":     { "type": "integer" },
    "is_public":  { "type": "boolean" },
    "word_count": { "type": "integer" },
    "publish_time": { "type": "date" },
    "created_at": { "type": "date" }
  }
  ```
- `indexDocument(payload: DocumentIndexPayload)`：`client.index({ index: DOC_INDEX, id: payload.docId, document: {...} })` —— **_id=docId 天然幂等**，重复发布即覆盖更新（对应图中「创建/更新文档索引」，比 RAG 的先删后写更简单）
- `search(q: string, page: number, pageSize: number)`：
  - `multi_match: { query: q, fields: ['title^2', 'summary', 'content'] }`（标题加权）
  - `from/size` 分页，`_source: { excludes: ['content'] }`（列表结果不回传整篇正文，避免响应过大）
  - 返回 `{ total, page, pageSize, items: [{ doc_id, title, summary, word_count, publish_time, score }] }`

### 4. 修改 `src/es/es.module.ts`

providers/exports 追加 `DocIndexService`（@Global，检索模块与 pipeline 消费者直接注入）。

### 5. 新建 `src/pipeline/search-index.service.ts`（Search 消费者）

对应图中「Search 消费者 监听 kh.document.search.queue → 处理 INDEX 消息 → 创建/更新文档索引」：

- `onModuleInit`：`mq.consume(QUEUE_DOC_SEARCH, handler)`（复用 mq 封装的 prefetch=1 + 失败 ack 丢弃）
- `process(payload)`：校验 `docId` 存在（缺失 warn 跳过，与 RAG 消费者一致）→ `docIndex.indexDocument(payload)`
- 消息体已含整篇快照，**无需回查数据库**（与 RAG 消费者查库模式的关键差异，严格按图）
- 全程日志带 docId（项目惯例）

### 6. 修改 `src/pipeline/pipeline.module.ts`

providers 追加 `SearchIndexService`。

### 7. 新建 `src/search/` 检索 API 模块（用户决策项）

- `src/search/search.controller.ts`：
  ```ts
  @Controller('search')
  @Get() search(@Query() dto: SearchQueryDto)
  ```
  直接注入全局 `DocIndexService`（无中间 service，控制器薄封装）
- `src/search/search.dto.ts`：`SearchQueryDto` —— `q`（必填，@IsString() 非空）、`page`（默认 1）、`pageSize`（默认 10，上限 50），风格对齐 [query-document.dto.ts](file:///d:/桌面/AI项目/企业级知识库/knowledge-hub-backend/src/document/dto/query-document.dto.ts)
- `src/search/search.module.ts`：声明 controller；在 `src/app.module.ts` imports 追加 `SearchModule`

### 8. 测试文档更新 `test/curl/payload/curl.md`

- publish 用例预期更新：`queues` 变为 `["rag","kg"]` + `indexExchange: "kh.document.exchange"`
- 追加验证用例：
  - `curl http://localhost:9200/kh_document/_doc/{docId}`（快照落库）
  - `curl "http://localhost:3000/search?q=<中文关键词>"`（检索 API，UTF-8 URL 编码沿用现有惯例）
- RabbitMQ 管理台一次性清理：旧 `search.queue` 及其与 `document.events` 的绑定（代码不再声明，broker 残留需手动删，:15672 → Queues → Delete）

### 不做（保持边界）

- 不做文档删除时清理 kh_document/kh_chunk（TODO 注释保留）
- 不做 highlight 高亮、bool 过滤（status/is_public 筛选）、kNN+BM25 hybrid —— 留后续迭代
- 不动 RAG 链路任何代码（pipeline.service.ts / vector-index.service.ts 零改动）
- .env 无新增配置（交换机/队列/索引名按一期惯例硬编码为常量）

## Assumptions & Decisions

- **消息体携带整篇快照**（图示明确「发送 INDEX 消息(整篇元数据 + 正文)」），消费者不回查库——与 RAG 的 docId 查库模式刻意不同，两者共存不冲突（不同交换机/队列/消息契约）
- **_id=docId upsert 幂等**：重复发布覆盖写，天然防重；比 kh_chunk 的先删后写更贴合「创建/更新文档索引」语义
- **topic 交换机命名严格按图**：`kh.document.exchange` / `kh.document.search.queue` / `document.index`（topic 类型为后续 `document.*` 多 routing key 预留，本期只用 `document.index`）
- **旧 search 链路彻底移除**（用户确认）：`ROUTING_KEYS` 缩为 `['rag','kg']`，broker 残留队列手动清理一次
- **搜索结果不回传 content**：`_source excludes`，整篇正文可能数百 KB，列表场景无意义
- **快照 content 允许为空串**：创建类文档可能未解析完成即发布，落 ES 后重新发布即修复（POC 可接受）

## Verification

1. `pnpm build` 编译通过
2. 重启 dev server；RabbitMQ :15672 核对：
   - `kh.document.exchange`（type=topic）存在，`kh.document.search.queue` 以 `document.index` 绑定
   - `document.events` 仍为 direct，仅 rag/kg 两队列绑定
   - 手动删除残留的 `search.queue` 及旧绑定
3. 复用已发布文档 `POST /document/{id}/publish` → 响应含 `indexExchange`；服务日志出现「快照投递 docId=…」→「消息消费完成 queue=kh.document.search.queue docId=…」
4. `curl http://localhost:9200/kh_document/_doc/7504813748293472256` 返回快照（title/summary/content/元数据齐全，中文正常）；`kh_document/_count` ≥ 1
5. 幂等：同文档重复 publish → `_count` 不变，`_doc` 内容为最新（_id=docId 覆盖）
6. PATCH 防重：`PATCH /document/{id}` status 0→1 触发索引更新；再次 PATCH status=1 日志无新投递
7. 检索 API：`curl "http://localhost:3000/search?q=前端"`（UTF-8）返回命中文档（title/summary/score），中文 ik 分词生效；分页参数 `page/pageSize` 生效
8. RAG 回归：kh_chunk 链路不受影响（重复 publish 后 `_count` 与 chunk 数稳定）
