---
status: historical
updated: 2026-09-15
---

# KG 知识图谱管线工单（Neo4j：实体抽取 + 图谱构建 + 删除清理）

> 依据：架构图《KG 管道（知识图谱）》（文档快照 → 分块 → 抽取实体 → 抽取关系 → 构建图谱 → 存储到 Neo4j）
> + 一期工单 [document-publish-rag-pipeline.md](file:///d:/桌面/AI项目/企业级知识库/knowledge-hub-backend/.trae/documents/document-publish-rag-pipeline.md) 的预留设计。
> 用户已确认三项决策：**复用 kg.queue**（不新建交换机）、**qwen-plus 抽取**（DashScope 兼容端点）、**复用 RAG chunkMarkdown 分块**。

## Summary

为 `document.events` 交换机上已存在的 `kg.queue`（routing key `kg`，一期已声明且 publish 已投递消息）落地消费者，实现完整 KG 管线：

```
发布（POST /document/:id/publish 或 PATCH status 0→1）
  → mq模块: document.events ──► kg.queue（已存在，消息已在堆积）
       └─ kg模块（本期实现）：
          1. 文档快照：查 Mongo 正文（parse_state=success）
          2. 分块：复用 chunkMarkdown（markdown 模式，RAG_CHUNK_MAX_CHARS=500）
          3. 抽取实体+关系：ChatOpenAI(qwen-plus) + structured output（zod 约束 JSON）
          4. 构建图谱：Document -[:HAS_CHUNK]-> Chunk -[:MENTIONS]-> Entity -[:RELATED_TO]-> Entity
          5. 存入 Neo4j（MERGE 幂等 + UNWIND 批量写）
```

删除（`DELETE /document/:id`）扩展：删除该文档的 Document/Chunk 节点 → 清理孤儿实体（不再被任何 Chunk MENTIONS 的 Entity）。

图模型（用户指定，`METIONS` 为笔误已修正为 `MENTIONS`）：

```
(:Document {docId, title}) -[:HAS_CHUNK]-> (:Chunk {docId, chunkIndex, content})
(:Chunk) -[:MENTIONS]-> (:Entity {name, type, description})
(:Entity) -[:RELATED_TO {relation}]-> (:Entity)
```

## Current State Analysis

- [mq.service.ts](file:///d:/桌面/AI项目/企业级知识库/knowledge-hub-backend/src/mq/mq.service.ts#L71-L73)：`kg.queue` 已声明并绑定 `document.events`（routing key `kg`），L71 有 `// TODO(二期): KG 消费者——实体关系抽取写 Neo4j` 占位注释
- [document.service.ts](file:///d:/桌面/AI项目/企业级知识库/knowledge-hub-backend/src/document/document.service.ts#L214-L230)：`dispatchPublish` 已向 `kg` 投递 `{docId, title, publishedAt}`，无需改发布端
- [document.service.ts](file:///d:/桌面/AI项目/企业级知识库/knowledge-hub-backend/src/document/document.service.ts#L288-L315)：`remove()` 已清理 kh_chunk/kh_document（各自 try/catch 不阻断），KG 清理照此模式追加
- [pipeline.service.ts](file:///d:/桌面/AI项目/企业级知识库/knowledge-hub-backend/src/pipeline/pipeline.service.ts)：RAG 消费者模板——查 Mongo `contentModel.findOne({ documentId, deleted: false })`，`parse_state !== 'success'` 跳过；KG 消费者沿用同一快照查询
- [chunker.ts](file:///d:/桌面/AI项目/企业级知识库/knowledge-hub-backend/src/pipeline/chunker.ts)：`chunkMarkdown(md, maxChars)` 纯函数可直接 import 复用
- [embedding.service.ts](file:///d:/桌面/AI项目/企业级知识库/knowledge-hub-backend/src/pipeline/embedding.service.ts)：懒初始化 LangChain 客户端惯例（`getClient()` + 配置缺失报错），KG 抽取服务照此风格
- [pipeline.module.ts](file:///d:/桌面/AI项目/企业级知识库/knowledge-hub-backend/src/pipeline/pipeline.module.ts)：消费者模块注册模式（MongooseModule.forFeature 引 DocumentContent schema）
- [docker.compose.yml](file:///d:/桌面/AI项目/企业级知识库/knowledge-hub-backend/docker.compose.yml#L161-L175)：Neo4j 容器已就绪（`neo4j:latest`，:7474 Web / :7687 Bolt，账号 neo4j/12345678，已装 APOC——本期用不到 APOC）
- [package.json](file:///d:/桌面/AI项目/企业级知识库/knowledge-hub-backend/package.json)：无 neo4j 驱动、无 zod（@langchain 的 structured output 需要显式安装 zod，pnpm 严格 node_modules 下不可引传递依赖）
- [.env](file:///d:/桌面/AI项目/企业级知识库/knowledge-hub-backend/.env)：已有 `OPENAI_API_KEY` + `EMBEDDING_BASE_URL`（dashscope compatible-mode）；无 Neo4j 连接配置、无 Chat 模型配置
- 项目惯例：服务手写封装、日志带 docId、雪花ID 字符串、消费失败错误日志 + ack 丢弃不重投

## Proposed Changes

### 1. 安装依赖

```bash
pnpm add -E neo4j-driver zod
```

- `neo4j-driver`：官方 Bolt 驱动（自带 TS 类型，无需 @types）
- `zod`：定义 structured output schema（ChatOpenAI.withStructuredOutput）

> 注意：本工作区 pnpm install/build 需关闭沙箱执行（store 在 D:\.pnpm-store）。

### 2. 修改 `.env`（追加）

```env
# ---- 知识图谱 Neo4j ----
NEO4J_URI=bolt://localhost:7687
NEO4J_USER=neo4j
NEO4J_PASSWORD=12345678

# ---- KG 实体抽取 LLM（复用 OPENAI_API_KEY / EMBEDDING_BASE_URL 端点）----
LLM_MODEL=qwen-plus
```

### 3. 新建 `src/kg/` 模块（4 个文件）

**`neo4j.service.ts`**（驱动封装，对齐 EsService「纯客户端」分层）：
- 懒初始化：`getDriver()` 首次调用时读 `NEO4J_URI/NEO4J_USER/NEO4J_PASSWORD`（缺失即抛错，对齐 EmbeddingService 风格），`neo4j.driver(uri, { user, password })`
- `run(cypher: string, params?: Record<string, unknown>): Promise<Record<string, any>[]>`：`executeWrite`（托管事务，自动重试瞬态错误），返回 records 的 `toObject()`
- `onModuleDestroy`：`driver.close()`
- 不做 `verifyConnectivity` 常驻检查——失败自然抛给消费者错误日志（与 RAG 消费者失败语义一致）

**`extraction.service.ts`**（对应图「抽取实体」「抽取关系」）：
- 懒初始化 `ChatOpenAI`：`{ modelName: LLM_MODEL(qwen-plus), openAIApiKey: OPENAI_API_KEY, configuration: { baseURL: EMBEDDING_BASE_URL } }`（复用现有 DashScope 兼容端点，不新增 key）
- `withStructuredOutput(zod schema)` 约束返回 JSON：

```ts
z.object({
  entities: z.array(z.object({
    name: z.string(),          // 实体名（去重键的一部分）
    type: z.enum(['person', 'org', 'tech', 'location', 'term', 'other']),
    description: z.string().optional(),
  })),
  relations: z.array(z.object({
    source: z.object({ name: z.string(), type: z.enum([...同上]) }),
    target: z.object({ name: z.string(), type: z.enum([...同上]) }),
    relation: z.string(),      // 动词短语，如 隶属/参与/使用/研发
  })),
})
```

- `extract(text: string): Promise<Extraction>`：中文系统提示词（识别人/组织/技术/地点/术语等实体及实体间关系，仅基于给定文本，关系两端必须出自 entities 列表）
- 代码侧后处理：过滤 relation 中 source/target 不在 entities 列表的脏数据；按 `source+target+relation` 去重

**`kg.service.ts`**（对应图「构建图谱」「存储到 Neo4j」）：
- `buildGraph(docId, title, chunks, extractions)`，三个批量写事务（UNWIND，空数组在代码侧跳过）：

```cypher
-- ① Document + Chunk + HAS_CHUNK（用户指定顺序：先文档节点、再 chunk 节点、再关系）
MERGE (d:Document {docId: $docId})
SET d.title = $title
WITH d UNWIND $chunks AS c
MERGE (chk:Chunk {docId: $docId, chunkIndex: c.index})
SET chk.content = c.content
MERGE (d)-[:HAS_CHUNK]->(chk)

-- ② Entity（MERGE 去重：name+type 复合键）+ MENTIONS
UNWIND $mentions AS m
MATCH (chk:Chunk {docId: m.docId, chunkIndex: m.chunkIndex})
MERGE (e:Entity {name: m.name, type: m.type})
SET e.description = coalesce(m.description, e.description)
MERGE (chk)-[:MENTIONS]->(e)

-- ③ RELATED_TO（实体间关系，relation 存为关系属性，动态类型不建多关系类型）
UNWIND $rels AS r
MATCH (a:Entity {name: r.sourceName, type: r.sourceType})
MATCH (b:Entity {name: r.targetName, type: r.targetType})
MERGE (a)-[rel:RELATED_TO]->(b)
ON CREATE SET rel.relation = r.relation
```

- `removeDocGraph(docId)`（两步，用户指定顺序：先删文档包含的 chunk，再删孤儿实体）：

```cypher
-- ① 删 Document + 其 Chunk（DETACH DELETE 连带清理 HAS_CHUNK/MENTIONS）
MATCH (d:Document {docId: $docId})
OPTIONAL MATCH (d)-[:HAS_CHUNK]->(c:Chunk)
DETACH DELETE d, c

-- ② 孤儿实体：不再被任何 Chunk MENTIONS 的 Entity
MATCH (e:Entity)
WHERE NOT EXISTS { ()-[:MENTIONS]->(e) }
DETACH DELETE e
```

- 幂等设计（对齐 RAG「先删后写」）：`rebuildGraph = removeDocGraph(docId) + buildGraph(...)`。孤儿清理保证：重建后旧版遗留且不再被引用的实体被清掉；被其他文档共享的实体因仍有 MENTIONS 不会误删

**`kg-pipeline.service.ts`**（消费者，对应整条 KG 管道）：
- `onModuleInit` 中 `mq.consume(QUEUE_KG, ...)`（import 自 mq.service.ts，不改 mq 拓扑）
- 流程（全程日志带 docId）：
  1. **文档快照**：`contentModel.findOne({ documentId: docId, deleted: false })`，`parse_state !== 'success'` 或无正文 → 日志后 return（ack 跳过，对齐 RAG 消费者）
  2. **分块**：`chunkMarkdown(content, RAG_CHUNK_MAX_CHARS)`（复用 pipeline/chunker.ts，与向量块对齐）
  3. **抽取**：逐块 `extraction.extract(chunk.content)`（串行，prefetch=1 天然限流）
  4. **写图**：`kg.rebuildGraph(docId, title, chunks, extractions)`（先删后写幂等）
- 任一步抛错 → mq 模块错误日志（含 docId）+ ack 丢弃，不重投（项目既有约定，DLQ 留 TODO）

**`kg.module.ts`**：
- `MongooseModule.forFeature([{ name: DocumentContent.name, schema: DocumentContentSchema }])`
- providers：`Neo4jService`、`ExtractionService`、`KgService`、`KgPipelineService`

### 4. 修改 `src/app.module.ts`

imports 追加 `KgModule`（MqService 为全局模块，无需其他接线）。

### 5. 修改 `src/document/document.service.ts`（删除清理）

`remove()` 中追加（照 kh_chunk/kh_document 清理的 try/catch 模式，失败仅记日志不阻断删除）：

```ts
try {
    await this.kg.removeDocGraph(docId);
} catch (err) {
    this.logger.error(`清理 Neo4j 图谱失败 docId=${docId}: ${(err as Error).message}`);
}
```

KgModule 为普通模块（非全局），DocumentModule 需在 imports 中引入 KgModule 以注入 KgService。

### 6. 修改 `src/mq/mq.service.ts`（仅注释，手术式）

L71 `// TODO(二期): KG 消费者——实体关系抽取写 Neo4j` → `// KG 消费者：kg 模块监听（实体关系抽取写 Neo4j）`。拓扑声明逻辑零改动。

## Assumptions & Decisions

- **复用 kg.queue**（用户已确认）：一期已预留该队列且 publish 已投递，仅补消费者；不新建交换机/队列，零拓扑改动
- **抽取模型 qwen-plus**（用户已确认）：经 DashScope 兼容端点，复用 `OPENAI_API_KEY` + `EMBEDDING_BASE_URL`，新增 `LLM_MODEL` 配置即可；structured output 由 `withStructuredOutput` + zod 保证
- **复用 RAG chunkMarkdown**（用户已确认）：KG Chunk 节点与 kh_chunk 向量块一一对应（同 index、同 content），后续可做「图谱 ↔ 向量块」互查
- **实体去重**：`MERGE (Entity {name, type})` 复合键，跨 chunk/跨文档同名同类型实体自动合并（对应图「实体去重」）
- **RELATED_TO 方向**：按 LLM 抽取的 source→target 存储，relation 文本存关系属性（动态关系词不建多关系类型，降低 schema 膨胀）
- **发布幂等**：先 `removeDocGraph` 再 `buildGraph`，重复 publish 图谱结果稳定（对齐 RAG delete_by_query 先删后写）
- **孤儿实体清理**：删除/重建时统一执行 `NOT EXISTS { ()-[:MENTIONS]->(e) }` 判定，跨文档共享实体不受影响
- **抽取失败语义**：与 RAG 消费者一致——错误日志（含 docId）+ ack 丢弃，不重投不 DLQ（POC 简化，TODO 留存）
- **不做**（后续工单）：README 增补 KG 说明、DLQ、KG 查询 API（图谱关联查询接口）、APOC 依赖、kg 消费失败重试队列

## Verification

1. `pnpm build` 编译通过
2. `docker compose -f docker.compose.yml up -d neo4j`（已在运行则跳过）；浏览器 :7474 以 neo4j/12345678 登录确认可用
3. 发布一份已解析成功的文档（`POST /document/:id/publish`）→ 服务日志依次出现 消费/分块/抽取/写图 docId 日志；:15672 中 `kg.queue` Ready≈0（积压消息被消费）
4. Neo4j :7474 Cypher 核对（resume 简历文档预期：1 Document、11 Chunk、若干 Entity、相关关系）：
   - `MATCH p=(:Document)-[:HAS_CHUNK]->(:Chunk) RETURN p`
   - `MATCH p=(:Chunk)-[:MENTIONS]->(:Entity) RETURN p`
   - `MATCH p=(:Entity)-[:RELATED_TO]->(:Entity) RETURN p`
5. 幂等：同一文档重复 publish → 节点/关系数量稳定（先删后写）
6. 删除：`DELETE /document/:id` → Document/Chunk 消失；未被其他文档引用的 Entity 消失，跨文档共享 Entity 保留
7. 失败路径：停 Neo4j 后发布 → kg 消费者错误日志含 docId、消息被 ack、队列不堵塞；重启 Neo4j 后重新 publish 可恢复
