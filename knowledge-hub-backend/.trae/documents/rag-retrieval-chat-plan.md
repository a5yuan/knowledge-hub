---
status: historical
updated: 2026-09-18
---

# RAG 链路检索问答工单计划（/rag/search + /ai/chat SSE）

## 一、需求摘要

结合项目现有 RAG 基建与混合检索架构图，新增两个接口：

1. **GET /rag/search** — 混合检索：关键词召回（BM25）+ 向量召回（KNN）→ RRF 倒数排名融合 → 重排模型精排（阿里 qwen3.7-text-rerank，环境变量配置）→ Top-K 上下文片段
2. **POST /ai/chat** — AI 问答：复用 /rag/search 检索上下文 → 提示词 + 检索文档 → LLM（qwen-plus）流式生成，SSE 推送 token 增量，结束事件携带完整答案 + 引用列表

已确认决策：
- **Reranker 本工单完整实现**（dashscope 原生 HTTP API，非 OpenAI 兼容端点），模型走 `RERANK_MODEL` 环境变量（默认 `qwen3.7-text-rerank`），失败降级为 RRF 排序
- **SSE 流式 + done 结束事件**（message 增量 → done 携带完整 answer + sources）
- 问答接口路径为 `/ai/chat`（AI 接口），检索接口保留 `/rag/search`（RAG 链路）

## 二、现状分析（Phase 1 调研结论）

| 现状 | 位置 | 结论 |
|---|---|---|
| kh_chunk mapping 已有 dense_vector(dims=1024, cosine, index:true) | src/es/vector-index.service.ts#L30-55 | 可直接 knn 查询，**但尚无 knn 搜索方法**（只有写/删） |
| kh_chunk 写入字段 doc_id/doc_title/chunk_index/content/embedding/created_at | vector-index.service.ts#L81-88 | 检索结果可直接用，doc_title 已入索引 |
| 关键词搜索先例（multi_match + ik 分词） | src/es/doc-index.service.ts#L173-230 | 查询结构可参考，但它在 kh_document 上，chunk 路需新写 |
| ChatOpenAI 构造先例 | src/kg/extraction.service.ts#L62-67 | `EMBEDDING_BASE_URL` + `OPENAI_API_KEY` + `LLM_MODEL`(qwen-plus) |
| 向量化服务 | src/pipeline/embedding.service.ts#L27-32 | `embed()` 可直接复用（batchSize 10） |
| SSE 先例 | 全项目 grep | **无**（Nest 11 + rxjs 7.8 已装，@Sse 可用；但 POST SSE 需手写 res.write，更可控） |
| 鉴权 | 全局 JwtAuthGuard → RolesGuard → PermissionsGuard | /rag/* 默认需 Bearer token，**不加 @Public** |
| EsModule | src/es/es.module.ts#L7 `@Global()` | RagModule 无需 import，直接注入 VectorIndexService/EsService |
| 模块注册 | src/app.module.ts#L39-47 | RagModule 注册在 SearchModule/KgModule 相邻 |
| curl.md | test/curl/payload/curl.md（现到 §20） | 新增 §21 |

## 三、改动清单

### 新建文件（6 个 + 文档）

**1. src/rag/rag.module.ts**
- providers: RagSearchService, AiChatService, RerankService；controllers: RagController, AiController
- 注册进 app.module.ts imports（SearchModule 旁）

**2. src/rag/dto/rag-search.dto.ts**
```ts
// GET /rag/search
q: string          // 1-100 字，@IsString @Length(1,100)
top_k: number      // 默认 5，@Type(()=>Number) @Min(1) @Max(20)，@IsOptional
rerank: 'true'|'false'  // 默认 true，@Transform 显式映射（沿用 2026-09-17 修复的 Boolean 坑写法，禁用 @Type(()=>Boolean)）
```

**3. src/rag/dto/rag-chat.dto.ts**
```ts
// POST /ai/chat
question: string   // 1-500 字
top_k: number      // 默认 5 max 10 可选
```

**4. src/rag/rerank.service.ts** — dashscope 重排模型精排
- `rerank(query: string, documents: string[], topN: number): Promise<RerankResult[] | null>`
- 原生 fetch POST（Nest 11 要求 Node 20+，原生 fetch 可用，不引 axios）
- URL：`RERANK_API_URL` env，默认 `https://dashscope.aliyuncs.com/api/v1/services/rerank/text-rerank/text-rerank`
- 模型：`RERANK_MODEL` env，默认 `qwen3.7-text-rerank`（阿里重排模型，与 EMBEDDING_MODEL=qwen3.7-text-embedding-flash 命名族一致）
- 鉴权：`Authorization: Bearer ${OPENAI_API_KEY}`（dashscope key 通用）
- body：`{ model, input: { query, documents }, parameters: { return_documents: false, top_n: topN } }`
- 响应解析：`resp.output.results[] → { index, relevance_score }`
- **降级策略**：AbortController 10s 超时 / 非 200 / 缺 env → `warn log` + 返回 null（调用方回退 RRF 顺序），不抛 500（沿用项目"失败不阻塞"风格）

**5. src/rag/rag-search.service.ts** — 混合检索编排
```
search(q, topK, rerank=true) → { items, took_ms }
```
流程：
1. `embedding.embed([q])` 得查询向量
2. 并行双路召回（各取 50 条，`_source`: doc_id/doc_title/chunk_index/content）：
   - 向量路：`vectorIndex.knnSearch(vector, 50)`（新增，见下）
   - 关键词路：`vectorIndex.textSearch(q, 50)`（新增，multi_match `doc_title^2, content`，ik 分词）
3. **RRF 融合**（导出纯函数 `rrfFuse` 便于单测）：`score(d) = Σ 1/(60 + rank_i(d))`，去重键 `doc_id + chunk_index`，两路 rank 从 1 起
4. RRF 排序取前 `min(topK*4, 40)` 为候选
5. `rerank=true` 且候选>0 → RerankService 按相关性重排取 topK；返回 null → RRF 顺序截断 topK
6. 返回 `items: [{ doc_id, doc_title, chunk_index, content, score, rank }]`，score 取 rerank 的 relevance_score（降级时为 rrf_score）

**6. src/rag/ai-chat.service.ts** — SSE 流式问答（AI 接口）
```ts
async chatStream(res: Response, question: string, topK: number): Promise<void>
```
- 先同步执行 `ragSearch.search(question, topK, true)` 拿上下文
- 手写 SSE（POST + 自定义 done 事件，@Sse 装饰器默认 GET 不适用）：
  - headers：`Content-Type: text/event-stream`、`Cache-Control: no-cache`、`Connection: keep-alive`，`flushHeaders()`
  - 事件协议：
    - `event: message` → `data: {"delta": "..."}`（token 增量）
    - `event: done` → `data: {"answer": "完整内容", "sources": [{doc_id, doc_title, chunk_index, score, rank}]}`
    - `event: error` → `data: {"message": "..."}`，随后 `res.end()`
- LLM：复用 extraction.service.ts 构造模式（EMBEDDING_BASE_URL/OPENAI_API_KEY/LLM_MODEL），`llm.stream([SystemMessage, HumanMessage])` 异步迭代，累积完整 answer
- 提示词（中文）：
  - System：企业知识库助手，仅依据给定上下文回答；上下文不足时明确说明；引用来源标注 [编号]；中文回答
  - Human：`【参考文档】\n[1] (来源: {doc_title})\n{content}\n...\n\n【问题】{question}`
- 检索 0 结果：仍走 LLM 直答（上下文区写"无"）？——否，**直接在 message 流前发 done(answer=提示语, sources=[])**，不调 LLM，省 token（明确行为：返回"知识库中未找到相关内容"提示）

**7. src/rag/rag.controller.ts + src/rag/ai.controller.ts**
```ts
// rag.controller.ts
@Controller('rag')
@Get('search')   // ragSearch.search(queryDto)

// ai.controller.ts
@Controller('ai')
@Post('chat')    // aiChat.chatStream(@Res() res, @Body() dto)  ← SSE
```
两者均登录态（无 @Public）；controller 薄层，逻辑全在 service。

**8. doc/rag-检索问答工单.md** — 交付工单文档（沿用 doc/rbac-权限模块工单.md 风格）
- 链路 mermaid 图（双路召回 → RRF 公式 → Reranker → LLM/SSE 事件时序）
- 接口契约（请求/响应/事件协议）、配置项、降级策略、验证记录、TODO（chunk 级权限过滤、多轮对话记忆、失败重排队）

### 修改文件（3 个）

**9. src/es/vector-index.service.ts** — 新增两个查询方法（复用 ensureReady 懒初始化）
```ts
async knnSearch(queryVector: number[], k: number): Promise<ChunkHit[]>
  // client.search({ index: CHUNK_INDEX, knn: { field: 'embedding', query_vector, k, num_candidates: 100 },
  //                _source: [doc_id,doc_title,chunk_index,content] })
async textSearch(q: string, size: number): Promise<ChunkHit[]>
  // multi_match: fields ['doc_title^2','content']
```
ChunkHit 接口定义于此并导出：`{ doc_id, doc_title, chunk_index, content, score }`

**10. src/app.module.ts** — imports 数组加 `RagModule`（SearchModule 之后）

**11. .env** — 追加 `RERANK_MODEL=qwen3.7-text-rerank`（RERANK_API_URL 代码内默认值，可覆盖）；若存在 .env.example 同步追加

**12. test/curl/payload/curl.md** — 新增 §21
- 21.1 GET /rag/search（含 rerank=false 对照）
- 21.2 POST /ai/chat SSE：`curl -N -X POST -H "Authorization: Bearer ${ACCESS_TOKEN}" --data-binary "@payload/ai-chat.json"`（中文 body 沿用 UTF-8 文件规范，文件无尾随换行）

## 四、关键设计决策

| 决策 | 理由 |
|---|---|
| 双路召回都在 kh_chunk 上做 | kh_chunk 才有向量；同粒度 RRF 去重键天然统一（doc_id+chunk_index） |
| Reranker 用原生 fetch 调 dashscope，模型 RERANK_MODEL=qwen3.7-text-rerank | 重排模型非 OpenAI 兼容端点；模型名环境变量化，与 EMBEDDING_MODEL 配置风格一致；不引 axios（Node20 原生 fetch 足够） |
| rerank 失败降级不 500 | 沿用项目惯例（ES 清理失败不阻塞删除）；精排是增强而非依赖 |
| POST 手写 SSE 而非 @Sse 装饰器 | Nest 的 @Sse() 强制 GET 路由、无法接收 POST body；question 含中文走 query string 有编码坑（项目有 PowerShell curl GBK 前科）且受 URL 长度限制。手写 res.write 保留 POST + JSON body；事件协议（message/done/error）两种方式均可表达 |
| chat 路径为 /ai/chat，检索为 /rag/search | 用户指定：问答是通用 AI 接口，检索属 RAG 链路；两 controller 同属 RagModule |
| 检索 0 结果不调 LLM | 明确省 token；返回固定提示 |
| v1 无权限过滤 | kh_chunk 无 status/is_public 字段，过滤无从谈起 → 工单记 TODO |
| v1 单轮对话 | 多轮记忆不在本工单范围 |

## 五、验证步骤

1. `pnpm build` 0 error
2. `pnpm test` — 既有 32 auth 用例不回归；新增 src/rag/rag-search.service.spec.ts：
   - rrfFuse 纯函数：两路打分正确、同 chunk 去重合并、排序正确
   - rerank 成功：按 relevance_score 重排取 top_n
   - rerank 失败（fetch 抛错/超时）：降级 RRF 顺序返回，不抛异常
   - （chat 流式为 IO 编排，v1 不写 spec，以 curl 实测覆盖）
3. 启动 dev server，curl 实测：
   - `GET /rag/search?q=知识库` → 返回混合排序片段（与既有已发布文档 kh_chunk 数据对照）
   - `GET /rag/search?q=xxx&rerank=false` → RRF 顺序，验证降级路径
   - 无 token → 401
   - `POST /ai/chat`（curl -N）→ 逐条 message 事件流出 token，done 事件含完整 answer + sources；检索无结果时直接 done 提示
4. 完成后写 doc/rag-检索问答工单.md（含链路图 + 验证记录）与 curl.md §21

## 六、假设

- OPENAI_API_KEY 即 dashscope key，同时具备 rerank 服务权限（gte-rerank-v2）
- Node ≥ 20（Nest 11 前提），原生 fetch 可用
- 既有 kh_chunk 数据可复用（此前 RAG 管线已灌入向量）
