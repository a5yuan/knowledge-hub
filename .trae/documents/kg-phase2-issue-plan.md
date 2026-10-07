---
status: historical
updated: 2026-09-21
---

# 知识图谱二期工单：在 backend-integration 新增 07 号工单文档

## Summary

在 `backend-integration/issues/` 下新增 **07 号工单文档**（唯一交付物，不改任何代码），命名对齐既有 `01-adapter-foundation.md` ~ `06-role-permission-plan.md` 风格：

**新文件：`d:\桌面\AI项目\企业级知识库\backend-integration\issues\07-kg-overview-phase2.md`**

工单内容 = 结合原型图与前后端现状，定义"知识图谱全景页（左中右三栏）"的前端 UI 改造点 + 后端 `overView`/search 接口契约 + 统计口径 + 数据缺口标注。文档结构对齐 [06-role-permission-plan.md](file:///d:/桌面/AI项目/企业级知识库/backend-integration/issues/06-role-permission-plan.md)：Summary / Current State（已探明）/ 原型说明 / Proposed Changes（前后端文件级）/ 数据契约 / Assumptions & Decisions / Verification。

## Current State（Phase 1 探明，写入工单的事实基础）

### 后端 `knowledge-hub-backend/src/kg/`（NestJS + Neo4j）
- 仅 3 个只读接口（[kg-query.controller.ts](file:///d:/桌面/AI项目/企业级知识库/knowledge-hub-backend/src/kg/kg-query.controller.ts)，前缀 `@Controller('kg')`，需登录即可）：
  - `GET /kg/search`（KgSearchDto：q 1-100 字必填、page、pageSize）→ `{ q, docs(ES命中), entities: KgEntityHit[], edges: KgEdgeRow[] }`
  - `GET /kg/nodes`（label/q/type 分页）、`GET /kg/edges`（rel/entity 分页）
- 图模型（kg.service.ts L44）：`(:Document {docId,title})-[:HAS_CHUNK]->(:Chunk {docId,chunkIndex,content})-[:MENTIONS]->(:Entity {name,type,description})-[:RELATED_TO {relation}]->(:Entity)`
- Entity.type ∈ `['person','org','tech','location','term','other']`（extraction.service.ts L10）；entity MERGE 键 = name+type
- Cypher 风格：参数化 + `toLower() CONTAINS` 子串匹配 + count/SKIP/LIMIT 分页 + `toPlain()` 归一化 Integer；读事务用 `runRead()`
- **无任何统计接口**；无节点时间属性（Document/Entity/Chunk 均无 createdAt 下发）；无标签/标注类节点与关系
- 数据产生：文档发布 → RabbitMQ `QUEUE_KG` → LLM 抽取（extraction.service.ts，zod schema）→ `rebuildGraph` 先删后写

### 前端 `knowledge-hub-front`
- [knowledge-graph/Index.vue](file:///d:/桌面/AI项目/企业级知识库/knowledge-hub-front/src/views/knowledge-graph/Index.vue) 为一期占位页（118 行，无数据/无图表），**可整体重写**，无其他耦合
- `echarts@^6.1.0` 已装（package.json L24）；[VChart.vue](file:///d:/桌面/AI项目/企业级知识库/knowledge-hub-front/src/components/charts/VChart.vue) 封装组件按需注册 `echarts.use([LineChart, PieChart, GridComponent, TooltipComponent, LegendComponent, CanvasRenderer])`（L9-10）——**缺 `GraphChart`，二期必须补注册**
- dashboard/Index.vue 是 ECharts 用法范例（computed 生成 option + `<VChart :option>` + 环形图）
- `src/api/` 无图谱模块；[endpoint.ts](file:///d:/桌面/AI项目/企业级知识库/knowledge-hub-front/src/api/endpoint.ts) 双通道硬约束（新资源须登记 REAL_ROOT/DEFAULT_MODE）；`src/mocks/handlers/` 无图谱 handler
- 路由 `/knowledge-graph`（router/index.ts L63-68）与顶栏菜单（MainLayout.vue L28）已挂载，无 permission 字段（登录即可见）

### 工单目录
- `backend-integration/issues/` 已有 01~06；`backend-todo.md` 为前端联调输出清单（新缺口可后续追加，本工单不强制改它）

## 工单文档撰写大纲与关键决策（执行时照此写）

### 1. Summary（复述原型）
- **前端**：知识图谱页重构为左中右三栏——左 nav（知识图谱/全景图谱）、中间搜索区 + ECharts 力导图（实体与边）+ 图例与缩放、右侧统计区（可滚动：图谱数据统计 / 知识类型分布 / 热点 top5）
- **后端**：新增 `GET /kg/overview` 全量图谱+统计一次下发；search 走已有 `GET /kg/search` 并增强 `type` 参数
- **通道**：`graphs` 资源走真实通道（`/real/kg`），不写 MSW handler（对齐 06 号工单 roles 先例）

### 2. 节点/边映射表（工单核心决策，复刻图片图例）
| 原型图例 | 颜色 | 数据来源 | 备注 |
|---|---|---|---|
| 文档 | 蓝 | `Document` 节点 | 点击节点打开 `/documents/:docId/preview` |
| 知识点 | 绿 | `Entity` type ∈ tech/location/term/other | |
| 人物 | 橙 | `Entity(person)` | |
| 组织 | 青 | `Entity(org)` | |
| 标签 | 紫 | **无对应数据，预留** | 图例保留，计数恒 0（对应原型"当前标签 0"） |
| 提及（实线蓝）| | `MENTIONS` 边（Document→Entity） | |
| 关联（虚线灰）| | `RELATED_TO` 边（Entity→Entity，带 relation 属性） | |
| 标注（点线紫）| | **无对应数据，预留** | 图例保留，恒空 |
- **Chunk/HAS_CHUNK 不下发**（内部结构，原型画布无此层）

### 3. 后端改造点（工单内文件级描述）
1. `src/kg/kg-query.dto.ts`：新增 `GetOverviewDto`（预留 limit 可选参数，默认/上限如 2000 节点）；`KgSearchDto` 增 `type?`（IsIn(['person','org','knowledge','document'])——`knowledge` 为 tech/location/term/other 归并）
2. `src/kg/kg.service.ts` 新增 `getOverview()`（runRead，多次 Cypher 聚合）：
   - nodes：Document 全量 + Entity 全量（不含 Chunk）；节点 id 约定 `document:{docId}` / `entity:{type}:{name}`
   - edges：`MENTIONS` + `RELATED_TO`（不含 HAS_CHUNK）；id 同上映射为 source/target
   - stats：`{ docNodes, entities, relatedEdges, mentionEdges, tags: 0 }`（tags 预留恒 0）
   - typeDist：Entity 按 type 分组计数
   - hotTop5：Entity 按 mentionCount（被 MENTIONS 入度）DESC 取 5，返回 `{ name, entityType, mentionCount, relatedCount }`
   - 超限保护：节点数 > limit 时按 mentionCount 优先截断并在响应附 `truncated: true`
3. `src/kg/kg.service.ts` 增强 `searchEntities/search`：支持 type 过滤（person/org/knowledge 直接映射 Cypher type IN 条件）
4. `src/kg/kg-query.controller.ts`：`@Get('overview')`（声明于其他路由无冲突，均可）；登录即可访问，不加权限装饰器（延续现状）

### 4. 接口契约（工单内给出 TS 类型）
```ts
// GET /kg/overview
interface GraphOverview {
  nodes: GraphNode[]            // { id, kind: 'document'|'entity', name, docId?, entityType?, description? }
  edges: GraphEdge[]            // { source, target, kind: 'mentions'|'related', relation? }
  stats: { docNodes: number; entities: number; relatedEdges: number; mentionEdges: number; tags: number }
  typeDist: { type: string; count: number }[]
  hotTop5: { name: string; entityType: string; mentionCount: number; relatedCount: number }[]
  truncated?: boolean
}
// GET /kg/search?q=&type=&page=&pageSize=   （现有接口 + type 增强，结构不变）
```
- **画布边数**不来自后端：前端按当前渲染（检索过滤后）边数动态计算，对应原型"画布边数 42"

### 5. 前端改造点（工单内文件级描述）
1. [endpoint.ts](file:///d:/桌面/AI项目/企业级知识库/knowledge-hub-front/src/api/endpoint.ts)：`REAL_ROOT` 加 `graphs: '/kg'`；`DEFAULT_MODE` 加 `graphs: 'real'`
2. 新建 `src/api/graph.ts`：上述类型 + `fetchGraphOverview()` / `searchGraph(params)`，全部经 `endpoint('graphs', ...)`
3. [VChart.vue](file:///d:/桌面/AI项目/企业级知识库/knowledge-hub-front/src/components/charts/VChart.vue)：`echarts.use([...])` 追加 `GraphChart`（保留原有注册）
4. 整体重写 [knowledge-graph/Index.vue](file:///d:/桌面/AI项目/企业级知识库/knowledge-hub-front/src/views/knowledge-graph/Index.vue) 为三栏（删除占位内容）：
   - **左**：`知识图谱` 标签 + el-menu 竖排单项「全景图谱」（激活态，复刻图片）
   - **中**：搜索区（el-input 关键词带清空、el-select 节点类型：全部/人物/组织/知识点、el-date-picker 两个 **disabled** + tooltip「Neo4j 节点无时间属性，日期筛选待后端支持」、重置/检索按钮、导出图谱按钮）+ VChart graph 力导图（`layout:'force'`，categories 按 5 类上色对应映射表，`edgeSymbol:['none','arrow']`，lineStyle：mentions 实线蓝/related 虚线灰/标注点线紫预留）+ 底部图例条 + 右下角缩放控件（+/−/复位，调用 dispatchAction）+ 提示文案「可拖拽节点，滚轮缩放；点击文档节点打开正文」
   - **右**：统计区（overflow-y:auto）：「图谱数据统计」6 卡片（文档节点/知识点/实体关系/文档提及/当前标签/画布边数）、「知识点类型分布」VChart 环形图、「热点 TOP5」列表（名称/类型/提及数）
5. 交互逻辑：进入页面并行拉 overview（全图）；检索 → `searchGraph(q, type)` → 以命中实体/文档节点及其边重建子图（画布边数联动）；重置 → 重新拉 overview；导出图谱 → 当前画布 nodes/edges 序列化 JSON 下载（Blob + a[download]）；点击文档节点 → `router.push('/documents/{docId}/preview')`
6. 拆分组件（可选）：`views/knowledge-graph/components/`（GraphSearchBar / GraphStatsPanel），若 Index.vue 超 ~400 行建议拆

### 6. 缺口与预留（工单单列一节，对齐 backend-todo.md 风格）
- 日期范围筛选：Neo4j 节点无时间属性 → UI 复刻但禁用（已确认方案）
- 标签节点 / 标注关系：后端无数据模型 → 图例保留、计数恒 0
- 知识类型体系差异：原型环形图的时间体系（TIME/PRODUCT 等）为参考示意，实际以抽取体系 person/org/tech/location/term/other 为准
- 全量大图保护：overview 上限截断 + `truncated` 标记

### 7. Verification（工单内写验收步骤）
- 后端：build 通过；启动后 curl——`GET /kg/overview` 结构/统计与 Neo4j 数据一致、`GET /kg/search?type=person` 过滤生效、401 未登录
- 前端：vue-tsc 构建通过；登录 → /knowledge-graph 三栏渲染、力导图拖拽/缩放/图例、检索"发票"类关键词子图切换、类型过滤、导出 JSON、点文档节点跳预览、右侧统计滚动与环形图
- 回归：菜单/路由无 permission 回归

## Assumptions & Decisions
- **仅产出工单文档**，不写前后端代码（已确认）
- 文档命名 `07-kg-overview-phase2.md`；结构与 06 号对齐；语言中文
- Chunk/HAS_CHUNK 不入画布；标签/标注为预留位；日期筛选禁用标注缺口（已确认）
- `graphs` 资源仅真实通道，无 MSW handler（对齐 06 roles 先例）
- 不修改 backend-todo.md 与 spec.md（工单内注明缺口，落地后由联调流程回写）

## 执行步骤
1. Write 新建 `backend-integration/issues/07-kg-overview-phase2.md`，按上述大纲/决策/契约完整撰写（含映射表、接口 TS 契约、文件级改造点、缺口节、Verification）
2. 复查：与 06 号文档结构一致；所有路径/行号引用准确；无遗留决策空位
