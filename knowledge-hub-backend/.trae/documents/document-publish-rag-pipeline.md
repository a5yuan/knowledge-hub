---
status: historical
updated: 2026-09-14
---

# 文档发布 + RabbitMQ + pipeline 分块向量化工单（一期）

> 依据两份架构图制定：首图（三队列总览）+ 新图（mq 模块 / pipeline 模块三段式）。
> 存储决策（用户已确认）：**RAG 向量写入 ES 索引 `kh_chunk`**（对齐首图"写入 ES_chunk → ES关键词库"），不建 PG 表；二期 Search 消费者复用同一 ES（文档级全文索引）。

## Summary

按架构图实现 `document模块 publish接口 → mq模块 → pipeline模块 → ES索引kh_chunk` 异步管线，**一期只落地 RAG 流水线**：

```
发布（POST /document/:id/publish 或 PATCH status 0→1）
  → mq模块: 投递到交换机 document.events
      ├─ search 队列 → 二期 TODO（Search 全文检索，复用同一 ES）
      ├─ rag   队列 → pipeline模块（本期实现）：消费 → 分块 → 向量化 → 写入 ES 索引 kh_chunk
      └─ kg    队列 → 二期 TODO（KG 知识图谱，写 Neo4j）
pipeline模块最终把 chunk + 向量写入 ES 索引 kh_chunk（dense_vector，支持 kNN + BM25 混合召回）
```

- Search / KG 队列本期照常声明并投递消息，消费者实现留 TODO。
- 对应新图三模块：**1. document 模块**（publish 接口）、**2. mq 模块**（RabbitMQ 封装）、**3. pipeline 模块**（流水线处理）。

## Current State Analysis

- [document.service.ts](file:///d:/桌面/AI项目/企业级知识库/knowledge-hub-backend/src/document/document.service.ts)：已有 CRUD + 上传解析（进程内异步），`update()` 直接 `Object.assign` 保存，无发布动作
- [document.controller.ts](file:///d:/桌面/AI项目/企业级知识库/knowledge-hub-backend/src/document/document.controller.ts)：无 publish 端点
- [document.entity.ts](file:///d:/桌面/AI项目/企业级知识库/knowledge-hub-backend/src/document/entities/document.entity.ts)：已有 `status`（0=草稿/1=已发布）、`publish_time` 字段，无需改表
- [document-content.schema.ts](file:///d:/桌面/AI项目/企业级知识库/knowledge-hub-backend/src/document/schemas/document-content.schema.ts)：正文/解析状态在 Mongo，pipeline 查库数据源
- [docker.compose.yml](file:///d:/桌面/AI项目/企业级知识库/knowledge-hub-backend/docker.compose.yml#L85-L118)：RabbitMQ 3.13（guest/guest, :5672/:15672）、ES 8.17+IK（:9200，安全认证已关）均已就绪
- [.env](file:///d:/桌面/AI项目/企业级知识库/knowledge-hub-backend/.env#L22-L25)：已有 `OPENAI_API_KEY` + `EMBEDDING_BASE_URL`（dashscope compatible-mode）+ `EMBEDDING_MODEL`；无 RABBITMQ/ES/分块配置
- [package.json](file:///d:/桌面/AI项目/企业级知识库/knowledge-hub-backend/package.json)：无 amqp / elasticsearch 客户端依赖
- 项目惯例：服务手写封装（如 [rustfs.service.ts](file:///d:/桌面/AI项目/企业级知识库/knowledge-hub-backend/src/storage/rustfs.service.ts)），日志带 docId，雪花ID 用字符串

## Proposed Changes

### 1. 安装依赖

```bash
pnpm add -E amqplib amqp-connection-manager @elastic/elasticsearch
pnpm add -D -E @types/amqplib
```

- `amqp-connection-manager`（基于 amqplib）：断线重连 + channel 管理，与项目手写封装风格一致
- `@elastic/elasticsearch` 锁 8.17.x，与 docker.compose.yml 中 ES 版本对齐

### 2. 新建 `src/mq/`（对应新图"2. mq 模块 RabbitMQ 封装"）

**`mq.service.ts`**：
- `onModuleInit`：连接 `RABBITMQ_URL`，声明 direct 交换机 `document.events`（durable），声明并绑定三个队列：
  | 队列 | routing key |
  |---|---|
  | `search.queue` | `search` |
  | `rag.queue` | `rag` |
  | `kg.queue` | `kg` |
- `publish(routingKey, payload)`：对应图中"发布(Publish)→投递到交换机"，persistent 消息，JSON + UTF-8
- `consume(queue, handler)`：对应图中"消费(Consume)"，prefetch 1，手动 ack；handler 成功 → ack；失败 → 错误日志（含 docId）后 ack 丢弃，**不无限重试**（TODO 二期加 DLQ）
- `// TODO(二期): Search消费者——全文检索写 ES 关键词库`、`// TODO(二期): KG消费者——实体关系抽取写 Neo4j` 占位注释

**`mq.module.ts`**：`@Global()` 模块，导出 MqService（生产者 DocumentModule 与消费者 PipelineModule 共用单例连接）。

### 3. 新建 `src/es/`（ES 客户端 + kh_chunk 索引）

**`es.service.ts`**：
- `onModuleInit`：连接 `ES_NODE`，索引 `kh_chunk` 不存在则创建：

```json
{
  "settings": { "number_of_shards": 1, "number_of_replicas": 0 },
  "mappings": { "properties": {
    "doc_id":      { "type": "keyword" },
    "doc_title":   { "type": "text", "analyzer": "ik_max_word", "search_analyzer": "ik_smart" },
    "chunk_index": { "type": "integer" },
    "content":     { "type": "text", "analyzer": "ik_max_word", "search_analyzer": "ik_smart" },
    "embedding":   { "type": "dense_vector", "dims": 1024, "index": true, "similarity": "cosine" },
    "created_at":  { "type": "date" }
  }}
}
```

- `bulkIndexChunks(docId, chunks)`：先 `delete_by_query {doc_id}`（重发布幂等），再 `_bulk` 写入
- `removeDocChunks(docId)`：预留（本期 document.remove 不调用，仅 TODO）

**`es.module.ts`**：`@Global()`，导出 EsService。

### 4. 新建 `src/pipeline/`（对应新图"3. pipeline 模块 流水线处理"）

**`chunker.ts`**（纯函数，对应"分块(文档切分)"）：`chunkMarkdown(md, maxChars)` — 按 `#` 标题切段 → 段落打包，块 ≤500 字符，跨块携带上一段作重叠；返回 `{ index, content }[]`。

**`embedding.service.ts`**（对应"向量化(生成向量)"）：
- `embed(texts: string[]): Promise<number[][]>`：`fetch POST ${EMBEDDING_BASE_URL}/embeddings`，`{ model: EMBEDDING_MODEL, input }`，每批 ≤10 条
- 校验返回向量维度 === `EMBEDDING_DIMS`，不符则报错（日志含期望/实际值）

**`pipeline.service.ts`**（`onModuleInit` 中 `mq.consume('rag.queue', ...)`，对应"监听 RabbitMQ 队列"，四步对应整体流程）：
1. **消费**：从 rag 队列取消息 `{ docId, title, publishedAt }`；查 Mongo `contentModel.findOne({ documentId, deleted: false })`，`parse_state !== 'success'` → 日志后 ack 跳过
2. **分块**：`chunkMarkdown(content, RAG_CHUNK_MAX_CHARS)`
3. **向量化**：分批 `embedding.embed(...)`
4. **写入 ES**：`es.bulkIndexChunks(docId, chunks)` 写入索引 kh_chunk
- 全程日志带 docId（项目惯例），任一步失败 → 错误日志 + ack（消息不重投）

**`pipeline.module.ts`**：无外部模块依赖（MqService / EsService 均为全局）。

### 5. 修改 `src/document/document.service.ts`（publish 接口 + 双触发 + 防重）

- 新增 `publish(id)`：校验存在且未删除 → `status=1`、`publish_time=now`、保存 → `dispatchPublish`
- 新增私有 `dispatchPublish(docId, title)`：向 `document.events` 依次投递 routing key `search` / `rag` / `kg`，payload `{ docId, title, publishedAt }`；try/catch 包裹，失败仅记日志不阻断发布接口
- 修改 `update()`：`Object.assign` 前先存 `prevStatus`；保存后 `doc.status === 1 && prevStatus !== 1` → `dispatchPublish`（只在 0→1 跳变触发，重复 PATCH status=1 不重投）
- 修改 `remove()`：加 TODO 注释（二期删除时清理 ES 索引 kh_chunk 中该 doc_id 的数据）

### 6. 修改 `src/document/document.controller.ts`

```ts
/** 发布文档：状态置为已发布并投递 Search/RAG/KG 三队列 */
@Post(':id/publish')
publish(@Param('id') id: string) { return this.documentService.publish(id); }
```

返回 `{ id, status: 1, publish_time, queues: ['search','rag','kg'] }`。

### 7. 修改 `src/app.module.ts`

imports 追加：`MqModule`、`EsModule`、`PipelineModule`（MqModule/EsModule 为全局模块，DocumentModule 无需改动 imports）。

### 8. 修改 `.env`

```env
# ---- RabbitMQ ----
RABBITMQ_URL=amqp://guest:guest@localhost:5672
# ---- Elasticsearch ----
ES_NODE=http://localhost:9200
# ---- RAG 分块/向量化 ----
EMBEDDING_DIMS=1024
RAG_CHUNK_MAX_CHARS=500
```

## Assumptions & Decisions

- **RAG 向量写 ES 索引 kh_chunk**（用户已确认，对齐首图）：单引擎同时支持向量 kNN + BM25 中文全文混合召回，二期 Search 复用同一 ES；不建 PG pgvector 表（规避 init.sql 首启才执行的迁移问题）
- **一期只做 RAG pipeline**（用户已确认）；Search/KG 队列照常声明投递，消息暂堆积（开发环境可接受），消费者为 TODO 占位
- **KG 留占位**（用户已确认）：不接 LLM，不新增 LLM_MODEL 配置
- **双触发 + 防重**（用户已确认）：独立 publish 接口为主，PATCH 0→1 跳变为辅；防重靠状态跳变检测 + 消费端 delete_by_query 先删后写幂等，双触发不会产生重复 chunk
- **amqp-connection-manager 而非 @golevelup/nestjs-rabbitmq**：依赖更少、重连开箱即用、与项目手写服务风格一致
- **EMBEDDING_DIMS=1024**：索引映射需固定维度，运行时校验实际返回，不符即报错
- **消费失败 ack 丢弃不重投**：POC 简化，避免毒消息阻塞队列；TODO DLQ
- **不做**：文档删除时清理 kh_chunk（TODO 注释保留）、Search 文档级全文索引（二期）、KG/Neo4j 相关代码

## Verification

1. `pnpm build` 编译通过
2. `docker compose -f docker.compose.yml up -d rabbitmq es`（应已在运行）；RabbitMQ 管理台 :15672 可见 `document.events` 交换机与三队列绑定
3. curl 上传/复用现有文档 → `POST /document/:id/publish` → 返回 status=1 + publish_time；:15672 中 `rag.queue` 消息被消费（Ready≈0），search/kg 队列消息堆积（符合预期）
4. pipeline 链路：服务日志依次出现 消费/分块/向量化/写入 docId 日志；`curl http://localhost:9200/kh_chunk/_count` > 0；`curl http://localhost:9200/kh_chunk/_mapping` 显示 embedding dims=1024；`_search` 按 doc_id 查回切块且中文分词正常；Kibana :5601 可视化核对
5. 幂等：同一文档重复 publish → kh_chunk 中该 doc_id 的 chunk 数量稳定（先删后写）
6. PATCH 防重：`PATCH /document/:id` status 0→1 触发投递；再次 PATCH status=1 不触发（日志无新投递）
7. 失败路径：停 ES 后发布 → pipeline 错误日志含 docId、消息被 ack、队列不堵塞
8. 在 `test/curl/payload/` 按现有惯例补 publish 测试脚本（UTF-8 处理沿用 upload-file.ps1 模式）
