---
status: historical
updated: 2026-09-17
---

# KG 图谱检索工单（Neo4j 查询 API：聚合关键词搜索 + 通用节点查询 + 通用关系查询）

> 依据：KG 管线工单 [document-kg-pipeline-neo4j.md](document-kg-pipeline-neo4j.md) 已落地的图数据。
> 图模型（已存在）：`(:Document {docId,title})-[:HAS_CHUNK]->(:Chunk {docId,chunkIndex,content})-[:MENTIONS]->(:Entity {name,type,description})-[:RELATED_TO {relation}]->(:Entity)`
> 用户已确认四项决策：①聚合搜索的文档结果走 **ES 复用**；②图谱检索用 **Cypher 对节点属性做关键词匹配**（toLower CONTAINS）；③**多 label 通用节点查询**（entity/document/chunk）；④**多类型通用关系查询**（related_to/mentions/has_chunk）。路由 **/kg/* 新控制器**（kg 模块内闭环）。

## Summary

```
GET /kg/search?q=         ①聚合关键词搜索：docs(ES 复用 DocIndexService.search) + entities(Neo4j Entity 属性匹配) + edges(Neo4j RELATED_TO 匹配)
GET /kg/nodes             ②通用节点查询：label=entity/document/chunk，关键词匹配对应节点属性（Cypher），entity 可选 type 过滤，分页
GET /kg/edges             ③通用关系查询：rel=related_to/mentions/has_chunk，可选 entity 实体名过滤边两端，分页
```

三个接口均为全局 JwtAuthGuard 保护（登录即可，无新权限标注，与 /search 现状一致）。

## Current State Analysis

- [kg.service.ts](file:///d:/桌面/AI项目/企业级知识库/knowledge-hub-backend/src/kg/kg.service.ts)：仅 buildGraph/rebuildGraph/removeDocGraph 写入与删除，**无查询方法**
- [neo4j.service.ts](file:///d:/桌面/AI项目/企业级知识库/knowledge-hub-backend/src/kg/neo4j.service.ts#L32)：`run()` 统一走 `session.executeWrite`（写事务+瞬态重试）；懒初始化驱动读 NEO4J_URI/USER/PASSWORD；**查询需补一个 executeRead 封装**
- [kg.module.ts](file:///d:/桌面/AI项目/企业级知识库/knowledge-hub-backend/src/kg/kg.module.ts#L19-L20)：providers 四服务，exports 仅 KgService，无 controllers
- [extraction.service.ts](file:///d:/桌面/AI项目/企业级知识库/knowledge-hub-backend/src/kg/extraction.service.ts#L10)：`ENTITY_TYPES = ['person','org','tech','location','term','other']`（需确认是否 export，未导出则补 `export`）
- 全仓库**无任何 Neo4j INDEX/CONSTRAINT**：关键词匹配用 `toLower(x) CONTAINS toLower($q)`（POC 数据量 <千级足够，FULLTEXT INDEX 留边界外）
- [search/search.controller.ts](file:///d:/桌面/AI项目/企业级知识库/knowledge-hub-backend/src/search/search.controller.ts)：DocIndexService 由 @Global EsModule 提供，kg 控制器可直接注入复用
- app.module.ts L46：KgModule 已注册，无需改 app.module
- curl.md：新用例按惯例追加 **§20**（文件末尾 §19 之后）

## Proposed Changes

### 1. src/kg/neo4j.service.ts（加只读查询封装，手术式）

- `run()` 保持不动（写事务语义）
- 新增 `runRead(cypher, params)`：`session({ defaultAccessMode: neo4j.session.READ })` + `session.executeRead(tx => tx.run(...))`，records → toObject()，与 run 同款返回结构

### 2. src/kg/extraction.service.ts（一行）

- `ENTITY_TYPES` 若未 export 则加 `export`（DTO type 校验复用）

### 3. src/kg/kg.service.ts（加 4 个只读查询方法）

全部用 `neo4j.runRead`，空结果返回空数组。通用类型：

```ts
export interface KgNodeHit { label: 'entity'|'document'|'chunk'; [k: string]: unknown }  // label + 节点业务属性
export interface KgEdgeHit { rel: 'RELATED_TO'|'MENTIONS'|'HAS_CHUNK'; start: Record<string, unknown>; end: Record<string, unknown>; properties?: Record<string, unknown> }
```

**① `searchGraph(q, limit)`**（聚合接口专用）：
- entities：`MATCH (e:Entity) WHERE toLower(e.name) CONTAINS toLower($q) OR toLower(coalesce(e.description,'')) CONTAINS toLower($q) RETURN e.name AS name, e.type AS type, e.description AS description ORDER BY e.name LIMIT $limit`
- edges：`MATCH (a:Entity)-[r:RELATED_TO]->(b:Entity) WHERE (toLower(r.relation) CONTAINS toLower($q)) OR (toLower(a.name) CONTAINS toLower($q)) OR (toLower(b.name) CONTAINS toLower($q)) RETURN a.name AS sourceName, a.type AS sourceType, r.relation AS relation, b.name AS targetName, b.type AS targetType ORDER BY relation, sourceName LIMIT $limit`

**② `searchNodes(label, q, type, page, pageSize)`**：按 label 代码侧分派 Cypher（switch 三分支），属性匹配映射：
- entity：name/description CONTAINS（q 为空则跳过 WHERE）；可选 `AND e.type=$type`；返回 name/type/description + mentionCount/relatedCount 统计（OPTIONAL MATCH COUNT），按 mentionCount DESC 排序
- document：title CONTAINS；返回 docId/title
- chunk：content CONTAINS；返回 docId/chunkIndex/content（**截断 200 字**，防响应过大）
- total：同 WHERE 的 count 查询；SKIP/LIMIT 分页
- 返回 `{ total, items: KgNodeHit[] }`（每项首字段 label）

**③ `searchEdges(rel, entity, page, pageSize)`**：按 rel 代码侧分派，`entity` 为可选实体名过滤（作用于边两端的 Entity 节点；has_chunk 两端无 Entity，忽略该参数）：
- related_to：`MATCH (a:Entity)-[r:RELATED_TO]->(b:Entity) [WHERE a.name=$entity OR b.name=$entity] RETURN a.name AS startName, a.type AS startType, r.relation AS relation, b.name AS endName, b.type AS endType`
- mentions：`MATCH (c:Chunk)-[:MENTIONS]->(e:Entity) [WHERE e.name=$entity] RETURN c.docId AS chunkDocId, c.chunkIndex AS chunkIndex, e.name AS entityName, e.type AS entityType`
- has_chunk：`MATCH (d:Document)-[:HAS_CHUNK]->(c:Chunk) RETURN d.docId AS docId, d.title AS title, c.chunkIndex AS chunkIndex, left(c.content, 200) AS contentPreview`
- total：同 WHERE 的 count；SKIP/LIMIT 分页；返回 `{ total, items: KgEdgeHit[] }`

**④ `nodeExists` 不需要**：edges 不再按实体 404（通用关系查询对不存在的 entity 名返回 total=0 空列表，语义自然）。

### 4. 新建 src/kg/kg-query.dto.ts

对齐 search.dto.ts 风格（@Type 转 Number、whitelist 下所有参数必须声明）：

- `KgSearchDto`：q 必填 @IsString @Length(1,100)；page=1 / pageSize=5（聚合单路条数 @Min(1) @Max(50)）
- `NodeSearchDto`：label 必填 @IsIn(['entity','document','chunk'])；q 可选 @IsString @Length(1,100)（不传=该 label 全量分页）；type 可选 @IsIn(ENTITY_TYPES)（仅 label=entity 生效，其余忽略）；page=1 / pageSize=10 @Max(50)
- `EdgeSearchDto`：rel 必填 @IsIn(['related_to','mentions','has_chunk'])；entity 可选 @IsString @Length(1,100)（实体名过滤）；page=1 / pageSize=10 @Max(50)

### 5. 新建 src/kg/kg-query.controller.ts

`@Controller('kg')`，注入 `KgService`（同模块）与 `DocIndexService`（@Global EsModule 提供）：

```ts
/** ① 聚合搜索：docs=ES 全文检索（带 highlight），entities/edges=Neo4j 图谱属性匹配 */
@Get('search')
async search(@Query() dto: KgSearchDto) {
  const [docs, graph] = await Promise.all([
    this.docIndex.search(dto.q, dto.page, dto.pageSize),
    this.kgService.searchGraph(dto.q, dto.pageSize),
  ]);
  return { q: dto.q, docs, entities: graph.entities, edges: graph.edges };
}

/** ② 通用节点查询（Cypher 属性匹配，分页） */
@Get('nodes')
searchNodes(@Query() dto: NodeSearchDto) {
  return this.kgService.searchNodes(dto.label, dto.q ?? '', dto.type, dto.page, dto.pageSize);
}

/** ③ 通用关系查询（rel 类型可选 + 实体名过滤可选，分页） */
@Get('edges')
searchEdges(@Query() dto: EdgeSearchDto) {
  return this.kgService.searchEdges(dto.rel, dto.entity, dto.page, dto.pageSize);
}
```

日志带 q/label/rel/entity（项目惯例）。

### 6. src/kg/kg.module.ts

controllers 追加 `KgQueryController`（providers 不变，同模块注入 KgService 闭环）。

### 7. test/curl/payload/curl.md（追加 §20）

用例（统一 `Authorization: Bearer ${ACCESS_TOKEN}`，中文经 UTF-8 文件 `--data-urlencode "q@file"`）：
- 聚合：`q=软星`（entities 命中）、`q=研发`（edges relation 命中）
- nodes：`label=entity`（q 空=全量分页）、`label=entity&q=软星`、`label=entity&q=软星&type=org`、`label=document&q=简历`、`label=chunk&q=前端`（content 截断生效）
- edges：`rel=related_to`（全量）、`rel=related_to&entity=<实体名>`（过滤）、`rel=mentions`、`rel=has_chunk`、`entity=不存在的实体` → total=0
- 未登录 401 矩阵沿用文件头惯例

## Assumptions & Decisions

- **图谱检索 = Cypher 属性匹配**（用户确认）：关键词对节点属性做 `toLower CONTAINS toLower($q)` 子串匹配，不建 FULLTEXT INDEX（数据量小，POC 边界外）
- **节点查询多 label**（用户确认）：entity（name/description）/ document（title）/ chunk（content，返回截断 200 字防响应过大）
- **关系查询多类型**（用户确认）：related_to / mentions / has_chunk 三类通用查询；entity 参数语义为「实体名过滤边两端的 Entity 节点」，对 has_chunk 无效（忽略）
- **文档结果复用 ES**（用户确认）：聚合接口 docs 直接 `DocIndexService.search(q, page, pageSize)`（含 highlight），Neo4j Document 节点仅在 nodes 接口按 title 匹配
- **chunk content 截断**：nodes/edges 返回的 content 统一 `left(content, 200)` 作为预览，完整正文走已有 GET /search/doc/:docId 或 GET /document/:id
- **不做**：Neo4j 索引/约束、图谱可视化布局数据、多跳路径查询、递归/变长路径、DLQ/重试

## Verification

1. `pnpm build` 编译通过
2. 重启 dev server；确认 Neo4j 运行且图有数据（`MATCH (n) RETURN count(n)` > 0，简历文档已发布过）
3. `GET /kg/search?q=软星`：`{ q, docs, entities, edges }` 三路返回，entities 含「软星」实体；docs 复用 ES 带 highlight
4. `GET /kg/search?q=研发`：edges 命中 relation 文本含「研发」的边
5. `GET /kg/nodes?label=entity&page=1&pageSize=5`：全量分页 + mentionCount/relatedCount 统计
6. `GET /kg/nodes?label=entity&q=软星&type=org`：type 过滤生效
7. `GET /kg/nodes?label=document&q=简历` / `label=chunk&q=前端`：title/content 属性匹配，chunk 返回截断预览
8. `GET /kg/edges?rel=related_to`：返回 RELATED_TO 边分页；`&entity=<实体名>` 过滤生效
9. `GET /kg/edges?rel=mentions` / `rel=has_chunk`：返回对应结构与分页
10. `GET /kg/edges?rel=related_to&entity=不存在的实体` → total=0 空列表
11. 未带 token → 401（全局 Guard 现状回归）
12. curl.md §20 用例全部执行通过
