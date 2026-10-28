---
status: evolving
updated: 2026-10-27
---

# Surface 设计：从硬编码事件到 catalog 驱动的界面契约

> 状态：设计稿（未实施）
> 关联：`knowledge-hub-backend/src/ai/tools/types.ts`（工单 23）、`src/ai/ai-agent.service.ts`（工单 08/11/12）
> 前提：不改动现有 SSE 单通道模型，不引入 langgraph / A2UI 运行时

---

## 一、问题陈述

现在的 UI 是「工具名 → 硬编码组件」的静态绑定，每一种展示形态都要动 **4 处**：

| 位置 | 文件 | 改动内容 |
|---|---|---|
| 事件类型 | `backend/src/ai/ai-agent.service.ts:43-60` | `data-*` 联合类型加一项 |
| 下发点 | 同上，工具执行后 `this.emit(res, 'data-xxx', ...)` | 新增 emit 调用 |
| 事件类型 | `front/src/api/ai.ts:AiEventData` | `data` 字段加一组可选属性 |
| handlers | `front/src/api/ai.ts:AiStreamHandlers` | 新增 `onXxx` 回调 |
| 渲染分支 | `front/src/api/ai.ts:171-229` + `AiChatPanel.vue` | switch 加 case + 模板加块 |

加第 6 个工具要写 5 个文件。这不是 bug，是**缺少一层「展示契约」导致的必然膨胀**。

目标：新增一种展示形态时，**前端渲染分支零改动**，只在 catalog 里注册组件。

非目标（明确不做）：
- 不做开放式 HTML 生成（`iframe` 沙箱）——安全面与视觉一致性都不划算
- 不做 surface 的流式增量拼装（patch）——本场景数据在工具返回时已完整，流式无收益
- 不引入 A2UI 运行时——理由见第七节

---

## 二、分层

```
┌─────────────────────────────────────────┐
│ L3  事件通道  data-surface（复用现有 SSE）│
├─────────────────────────────────────────┤
│ L2  Surface   扁平 components + id 引用  │
├─────────────────────────────────────────┤
│ L1  Catalog   组件白名单 + props schema  │
├─────────────────────────────────────────┤
│ L0  Vue 组件  6 个，与现有渲染一一对应    │
└─────────────────────────────────────────┘
```

三层职责边界：

- **Catalog** 决定「能出现什么」——这是权限模型，模型画不出目录外的东西
- **Surface** 决定「这一次要什么」——纯数据，无代码
- **Renderer** 决定「长什么样」——前端独占，后端不感知

---

## 三、数据结构

### 3.1 Surface

扁平存储 + id 引用，**不用嵌套树**：

```ts
// backend/src/ai/ui/surface.ts
export interface SurfaceNode {
  /** catalog 中的组件 id */
  type: string;
  props: Record<string, unknown>;
  /** 子节点 id 列表，顺序即渲染顺序 */
  children?: string[];
}

export interface Surface {
  surfaceId: string;
  /** 根节点 id */
  root: string;
  /** 节点表：id → node */
  nodes: Record<string, SurfaceNode>;
  /** 供节点 props 引用的共享数据，避免重复传大对象 */
  data?: Record<string, unknown>;
}
```

选扁平结构的三个理由：

1. **校验简单**：节点表一次性遍历，不需要递归；循环引用用一次拓扑检测就能拦掉
2. **增量更新成本为 O(1)**：将来若要支持 patch 或局部重渲染，按 id 命中即可，不用深递归 diff
3. **与 A2UI 的 `updateComponents` 消息同构**：将来真要迁移到标准协议，不用重构数据结构

一个知识检索结果的实例：

```json
{
  "surfaceId": "s_m1x2_3",
  "root": "root",
  "nodes": {
    "root": { "type": "stack", "props": { "gap": 8 }, "children": ["cards"] },
    "cards": {
      "type": "knowledgeCards",
      "props": {
        "query": "钢铁热处理工艺",
        "items": [{ "documentId": "1024", "documentTitle": "淬火工艺规范", "excerpt": "..." }]
      }
    }
  }
}
```

`data` 字段在类型上保留（对齐 A2UI 的 data model 绑定），但 **MVP 不启用指针语法**。原因见 3.3。

### 3.2 Catalog

```ts
// backend/src/ai/ui/catalog.ts
import { z } from 'zod';

export const CATALOG = {
  stack: {
    summary: '纵向排列子节点',
    props: z.object({ gap: z.number().min(0).max(32).default(8) }),
    slots: { children: true },
  },
  knowledgeCards: {
    summary: '知识库文档卡片列表，每张可点击跳转原文',
    props: z.object({
      query: z.string(),
      items: z.array(z.object({
        documentId: z.string(),
        documentTitle: z.string(),
        excerpt: z.string(),
      })).max(10),
    }),
  },
  webLinks: {
    summary: '网页搜索结果链接列表',
    props: z.object({
      query: z.string(),
      results: z.array(z.object({ title: z.string(), url: z.string().url() })).max(10),
    }),
  },
  graphMini: {
    summary: '知识图谱实体关系图，最多 20 节点',
    props: z.object({
      entities: z.array(z.object({
        name: z.string(), type: z.string(), description: z.string().optional(),
      })).max(20),
      relations: z.array(z.object({
        source: z.string(), relation: z.string(), target: z.string(),
      })).max(40),
    }),
  },
  sourceList: {
    summary: '编号引用来源列表，[n] 与正文标注对应',
    props: z.object({ sources: z.array(z.object({
      index: z.number(), kind: z.enum(['knowledge', 'web', 'graph']),
      title: z.string(), ref: z.string().optional(), url: z.string().optional(),
      excerpt: z.string().optional(),
    })) }),
  },
  memoryChips: {
    summary: '命中的记忆要点，最多 3 条',
    props: z.object({ memories: z.array(z.object({
      layer: z.enum(['user', 'session']), text: z.string(),
    })).max(3) }),
  },
  markdown: {
    summary: 'markdown 正文，只用于回答主体与降级兜底',
    props: z.object({ content: z.string() }),
  },
} as const;

export type CatalogId = keyof typeof CATALOG;
```

`summary` 不是注释，是**给模型看的**。注入 prompt 时只取 `id + summary + 必填 props 名`，不注入完整 zod schema。

### 3.3 事件

不新增通道，复用现有单通道 `data: {"type","data"}`：

```ts
| 'data-surface'   // 完整 surface 骨架
| 'data-surface-patch'  // 预留，MVP 不下发
```

载荷：

```ts
this.emit(res, 'data-surface', { surface: Surface });
```

`data-surface` 与现有的 `data-retrieve` / `data-web-search` 并存一段时间（双写），迁移完成后再删旧事件。

### 3.3 指针语法的取舍（实施时修正）

原设计里 props 支持 `@data.xxx` 指针，让多个组件共享同一批数据。实施时发现它和校验层冲突：**zod 校验需要真实值，指针会让 props 拿到字符串**，要么在校验前多一层解析、要么放弃校验的归一化能力。

当前只有 knowledgeCards 一个组件消费数据，没有共享收益，因此：

- **MVP 直接内联真实数据，不用指针**
- `data` 字段在类型上保留，为 P1 铺路
- P1 若要支持多组件共享，在 `validateSurface` 入口统一解析指针后再校验

这是「不为假设的需求付出复杂度」的一次具体取舍，也说明为什么先做垂直切片再铺开——如果一开始就 5 个 builder 全上，这个坑会在返工时暴露。

---

## 四、渲染器

```vue
<!-- front/src/components/surface/SurfaceRenderer.vue -->
<script setup lang="ts">
import { computed } from 'vue';
import { REGISTRY } from './registry';
import type { Surface } from '@/api/ai';

const props = defineProps<{ surface: Surface }>();

/** 解析 @data.xxx 指针 */
function resolve(value: unknown, data: Record<string, unknown>) {
  if (typeof value !== 'string' || !value.startsWith('@data.')) return value;
  return data[value.slice(6)];
}

/** 单节点递归渲染，深度上限 6 防炸栈 */
function renderNode(id: string, depth = 0): unknown {
  if (depth > 6) return null;
  const node = props.surface.nodes[id];
  // 白名单检查：catalog 外的组件直接丢弃，不渲染
  const component = node && REGISTRY[node.type];
  if (!component) return null;
  const resolved = Object.fromEntries(
    Object.entries(node.props ?? {}).map(([k, v]) => [k, resolve(v, props.surface.data ?? {})]),
  );
  return { component, props: resolved, children: (node.children ?? []).map((c) => renderNode(c, depth + 1)) };
}
</script>
```

`registry.ts` 是前端唯一的映射表：

```ts
// front/src/components/surface/registry.ts
import KnowledgeCards from '../cards/KnowledgeCards.vue';
import WebLinks from '../cards/WebLinks.vue';
import GraphMini from '../graph/GraphMini.vue';
import SourceList from '../cards/SourceList.vue';
import MemoryChips from '../cards/MemoryChips.vue';
import MarkdownRaw from '../markdown/MarkdownView.vue';
import StackLayout from '../layout/StackLayout.vue';

export const REGISTRY: Record<string, Component> = {
  knowledgeCards: KnowledgeCards,
  webLinks: WebLinks,
  graphMini: GraphMini,
  sourceList: SourceList,
  memoryChips: MemoryChips,
  markdown: MarkdownRaw,
  stack: StackLayout,
};
```

渲染时不使用动态 `<component :is>` 解析任意字符串——`REGISTRY` 是显式导入的静态映射，`type` 只能是它的 key。**这是白名单落地的位置，而不是在校验层。**

---

## 五、接入点

### 5.1 位置

在编排层的 emit 处，**不进工具层**。工具层继续只返回 `ToolResult`（`tools/types.ts` 的设计边界不变）：

```ts
// ai-agent.service.ts，原 L648 附近
- this.emit(res, 'data-retrieve', { query, items });
+ this.emit(res, 'data-surface', { surface: buildKnowledgeSurface({ query, items }) });
+ this.emit(res, 'data-retrieve', { query, items });   // 迁移期双写
```

Builder 是纯函数，放 `src/ai/ui/builders/`：

```ts
// backend/src/ai/ui/builders/knowledge.ts
export function buildKnowledgeSurface(input: {
  query: string; items: KnowledgeItem[]; sources: SourceDraft[];
}): Surface {
  return {
    surfaceId: `s_${nextId()}`,
    root: 'stack_1',
    nodes: {
      stack_1: { type: 'stack', props: { gap: 12 }, children: ['cards_1', 'sources_1'] },
      cards_1: { type: 'knowledgeCards', props: { query: input.query, items: '@data.items' } },
      sources_1: { type: 'sourceList', props: { sources: '@data.sources' } },
    },
    data: { items: input.items, sources: input.sources },
  };
}
```

纯函数的好处：可快照测试、可在回放时重建（见 5.2）。

### 5.2 持久化（已决策：**方案 A**，2026-10-28 实施）

`kh_ai_message` 原本只有 `content` + `sources`。surface 不落库的话，刷新页面回放只剩文字，图、卡片全丢。

当时列了两个方案，原倾向 B：

| | A. 加 `surfaces jsonb` 列 | B. 回放时按 sources 重建 |
|---|---|---|
| 迁移成本 | 改 `init.sql` + entity，一次 nullable 列 | 零迁移 |
| 回放一致性 | 完全一致 | 只能重建能从 sources 推出的部分（`graphMini` 推不出来） |
| 数据体积 | 消息体翻倍（surface 冗余了 sources） | 无 |
| 复杂度 | 低 | 需要保证 builder 幂等 + 前端在回放路径上调用 |

**实施时推翻了 B，改用 A**，原因是查了真实数据后发现 B 有两处硬伤：

1. **`sources` 是累积去重的，`surface` 是「最后一次检索」的快照。** `SourceRegistry.register` 会去重累积，一轮对话检索两次就有 5 条 sources；而 surface 按「覆盖式赋值」只反映最后一次命中的 3 条。用 sources 重建会**凭空多出条目** —— 不报错，但数字是错的。
2. **`excerpt` 是可选字段。** 缺失时重建的卡片只有标题没摘要，与流式时的视觉不一致。

成本估算也偏了：A 实际只动 4 处（`init.sql` 加列 + entity 加字段 + `appendMessage` 加参数 + `getMessages` 读出），比 B 的「builder 幂等 + 前端重建路径 + 处理上述两处偏差」更少。

**落地细节**：

- 列名 `surfaces`（复数，与 `sources` 对齐），类型 `JSONB`，nullable
- 写入前必须过 `validateSurface`：`emitSurface` 改为返回 `Surface | null`，**校验失败的坏 surface 不写库**
- 一轮内多次下发时，以**最后一次通过校验**的为准（`surfaceToPersist = emit(...) ?? surfaceToPersist`）
- 前端 `AiMessageView.surface` 有值时优先用它渲染；仅当前轮回落到内存里的 `streamSurface`
- 已有库需执行一次 `ALTER TABLE kh_ai_message ADD COLUMN IF NOT EXISTS surfaces JSONB;`

**实测结论（2026-10-28）**：提问 → 刷新 → 重新打开会话，卡片原样还原（命中数、查询词、摘要一致），DB 中 `surfaces` 约 443 字节。

### 5.3 降级链路

任何一层失败都必须回到文字，不能白屏：

```
surface 校验失败 → 记 warn + 丢弃该 surface → 前端仅渲染 markdown 正文
节点 type 不在 REGISTRY → 丢弃该节点及其子树（父级继续渲染）
props 校验失败 → 该节点替换为 markdown 兜底节点，内容为 "（该视图暂时无法展示）"
data 指针解析失败 → 保留原始字符串，不抛错
```

---

## 六、P1：让模型选组件

MVP 完成后，新增一个工具让模型自主组装界面：

```ts
// backend/src/ai/tools/render-ui.ts
export const renderUiTool = tool({
  name: 'render_ui',
  description:
    '当检索结果适合以卡片、对比、步骤等形式呈现时调用。'
    + '只能使用目录中的组件；不要用它输出纯文字答案。',
  schema: z.object({ surface: SurfaceSchema }),
  // 预算：单列 1 次，不占现有 3/1/1
});
```

### Prompt 注入策略（token 成本是重点）

**不要注入完整 schema。** 7 个组件的完整 zod 描述约 300 行，每次对话都付这个 token 是浪费。

三档注入：

| 档位 | 内容 | 量级 |
|---|---|---|
| 常驻 | `id` + `summary` + 必填 props 名 | 约 25 行 |
| 按需 | 模型调用 `render_ui` 后校验失败，错误信息里带回该组件的完整 schema | 单次 |
| 永不 | 完整 catalog | — |

也就是**用失败驱动 schema 下发**：第一次大概率试错，但错误信息本身就是修正指令，一次重试即收敛。相比常驻 300 行，这个策略在长会话里省下的 token 是数量级的。

兜底：`render_ui` 调用 2 次仍未通过校验，本轮禁用该工具，直接走静态 builder。

---

## 七、为什么不上 A2UI / MCP Apps

| | 收益 | 成本 | 结论 |
|---|---|---|---|
| A2UI | 跨端、跨渲染器可移植 | 新消息协议、surface 数据模型绑定、增量更新语义 | 单端 Vue，可移植性收益为 0 |
| MCP Apps | 工具作者控制像素 | iframe 沙箱、CSP、宿主消息校验 | 内部系统，视觉一致性 > 自由度 |
| AG-UI | 事件流标准化 | 现有 SSE 已够，无需替换 | 不适用 |

但**结构刻意与 A2UI 同构**：

- `nodes` 扁平表 + id 引用 ← A2UI 的 `updateComponents`
- `type` 走白名单 catalog ← A2UI 的 trusted catalog
- `data` 独立于 `nodes` ← A2UI 的 data model 绑定

所以将来要迁移到标准协议，是换传输层，不是重写渲染层。这是这个设计最重要的一句话。

---

## 八、分期与实施状态

### P0 垂直切片（已实施，2026-10-27）

只做 knowledgeCards 一条链路，验证契约是否够用，再决定要不要铺开。

| 文件 | 作用 |
|---|---|
| `backend/src/ai/ui/surface.ts` | 类型 + 校验裁剪（三处容错），`validateSurface` |
| `backend/src/ai/ui/catalog.ts` | catalog：stack / knowledgeCards / markdown |
| `backend/src/ai/ui/builders/knowledge.ts` | `buildKnowledgeSurface` 纯函数 |
| `backend/src/ai/ui/surface.spec.ts` | 10 个用例覆盖降级路径 |
| `backend/src/ai/ai-agent.service.ts` | 事件类型加 `data-surface`；`emitSurface()`；retrieve 处双写 |
| `front/src/components/surface/registry.ts` | type → 组件映射（渲染白名单） |
| `front/src/components/surface/SurfaceNode.vue` | 递归渲染（查表 + slot 传子节点） |
| `front/src/components/surface/SurfaceRenderer.vue` | 入口 + errorCaptured 兜底 |
| `front/src/components/cards/KnowledgeCards.vue` | 文档卡片（不含任何请求逻辑） |
| `front/src/components/layout/StackLayout.vue` | 纵向容器 |
| `front/src/api/ai.ts` | Surface 类型 + `onSurface` handler |
| `front/src/views/ai-qa/Index.vue` | `streamSurface` 状态与重置 |
| `front/src/views/ai-qa/components/AiChatPanel.vue` | 时间线之后、正文之前渲染 |

验收结果：
- `npx tsc --noEmit` 通过；`npx vue-tsc -b` 通过；`npx vite build` 成功
- `npx jest src/ai/ui/surface.spec.ts` → 10 passed
- 旧事件 `data-retrieve` 保留，`AiProcessTimeline` 未改动 → 视觉无回归风险

### P0 补丁（已实施，2026-10-28）

端到端验证时发现两处缺口，均已修复：

| 问题 | 影响 | 修复 |
|---|---|---|
| **前置检索路径没有 `emitSurface`** | `pipelineKbSearch` 命中后不再走工具调用，而多数提问在这一步就命中 —— 卡片几乎永远不出现，功能看起来完全没生效 | `ai-agent.service.ts` 前置检索命中处补下发 + 传入 `surfaceToPersist` |
| **刷新/切会话后卡片消失** | 演示经不起一次刷新 | 改 5.2 方案 A：`kh_ai_message.surfaces` 落库，回放原样还原 |

验收：`npx jest src/ai/ui/surface.spec.ts` → 10 passed；`npx vue-tsc -b` 通过；puppeteer 实测「提问 → 刷新 → 重开会话」卡片仍在（命中数、查询词、摘要一致）。

**教训**：P0 原有的验收只有单测 + 编译，没有端到端断言。单测覆盖的是 `validateSurface` 的坏输入，而「事件到底有没有发到前端」这一层完全没测 —— 于是最常走的路径漏了也发现不了。

### P0 铺开（部分完成，2026-10-28）

catalog 已扩到 7 个组件、registry 全部映射、4 个 builder 全部写好。**但下发侧只接了 3 类主形态**：

| 组件 | catalog | 前端组件 | builder | 后端下发 |
|---|---|---|---|---|
| `stack` / `knowledgeCards` / `markdown` | ✅ | ✅ | ✅ | ✅ |
| `webLinks` | ✅ | ✅ | ✅ | ✅ |
| `graphMini` | ✅ | ✅（复用 `GraphCanvas` mini 模式） | ✅ | ✅ |
| `sourceList` | ✅ | ✅ | ✅ | ❌ **有意不接** |
| `memoryChips` | ✅ | ✅ | ✅ | ❌ **有意不接** |

**为什么不接 memory / sources**：它们在**本轮最后**才下发（`data-memory` 在检索之后、`data-sources` 在 `finish` 之前）。而 surface 的语义是「覆盖式，以最后一次为准」—— 接了就会把刚出现的检索卡片**替换掉**，用户会看到卡片闪一下就变了样。

它们各自的专用 UI 已经稳定（时间线里的记忆卡、正文下方的引用块），没必要搬进 surface。**能力保留**：catalog 与 registry 都已就绪。将来若要「卡片 + 来源」并列展示，正确做法是把两者**组合进同一个 surface 一次下发**，而不是发两次让后者覆盖前者。

**实测（2026-10-28）**：

| 问题 | surface 内组件 | 计数 |
|---|---|---|
| 知识库类（项目立项与审批流程） | 仅 `kc` | 命中 1 篇文档 |
| 联网类（今天杭州天气） | 仅 `wl` | 检索到 5 条结果 |

两者均无 memory / sources 覆盖，引用块仍由原有 `source-box` 渲染。

### graphMini 验证（2026-10-28）

**意图路由导致图谱形态极难触发。** `knowledge` 意图虽然挂了 `retrieve_graph`（见 `toolsForIntent`），但前置检索一旦命中，模型拿到足够上下文就不会再调图谱工具。实测 3 个关系型提问：

| 提问 | `data-graph` | 实际走的通道 |
|---|---|---|
| 王工负责什么工作，和其他角色是什么关系 | ❌ | 前置检索命中 → 只有 `knowledgeCards` |
| 项目立项流程涉及哪些角色，他们之间怎么协作 | ❌ | 同上 |
| 技术评估和预算审批之间有什么关系 | ❌ | 未检索（意图判为非知识库类） |

改为**组件级验证**：临时 Vite 入口页用真实数据渲染 `GraphMini`（6 实体 / 5 关系），确认力导图正常绘制 —— canvas 694×280、节点按实体类型着色、关系虚线可见。验证后临时入口页已删除。

**遗留判断**（当日已修复，见下节）：图谱卡片在真实会话中出现概率很低。这不是 genui 的缺陷，是「前置检索强命中 + 工具门控」共同作用的结果。

### graphMini 触发率修复（2026-10-28）

排查下来是**四层原因叠在一起**，每修一层才暴露下一层：

| 层 | 现象 | 根因 | 修复 |
|---|---|---|---|
| 1 | `data-graph` 一次都不下发 | 前置检索命中后模型手里已有原文，不再调工具 | 前置阶段**并行预检**图谱，不依赖模型决策 |
| 2 | 预检 `实体=0 关系=0` | Cypher 是 `实体名 CONTAINS 查询词`，传整句必然 0 命中 | 改用 planner 的 `suggestedTerms` 短词，逐个查、按实体名去重合并 |
| 3 | 换短词后仍 0 命中 | planner 对「高炉炼铁涉及哪些技术」判 `needRetrieve=false`，图谱预检被一起跳过 | 预检条件**不绑 `needRetrieve`**，只要求意图允许知识库 |
| 4 | 「高炉炼铁」查不到实体「高炉」 | 复合词 vs 短实体名，`高炉` 不包含 `高炉炼铁` | 词表扩展：长度 ≥3 的中文词再取前 2 字 |

**实测（3 个提问）**：

| 提问 | 结果 |
|---|---|
| 高炉炼铁涉及哪些技术 | ✅ 图谱 11 实体 / 22 关系，正文完全基于图谱实体组织 |
| 炼钢和连铸之间有什么关系 | ✅ 图谱 5 实体 / 10 关系 |
| 钢铁行业数字化转型有哪些重点任务 | ❌ 不触发（`intent=web`，按门控不进知识库分支，**合理**） |

**设计要点**：

- 预检与知识库检索**并行**（`Promise.all`），不增加首屏延迟
- 只有「≥2 实体 + ≥1 关系」才并入（`kgMeaningful`），避免零散实体变噪音
- 图谱关系拼成 `【知识图谱关联】` 文本注入上下文 —— 模型**真的用它组织回答**，不只是界面上画一下
- 预检失败一律降级为空，绝不影响主链路
- **图谱走时间轴，不走结果区**：预检成功时下发 `data-graph`，由 `AiProcessTimeline` 渲染（可折叠的 mini 力导图 + 关系三元组列表）。时间轴该项本身就是完整展示，再往 surface 放一份 `graphMini` 就是同一张图画两遍 —— 与知识库的「时间轴记过程 + 结果区放卡片」不同，图谱的过程与结果同构，不需要拆两处
- `graphMini` 组件与 `composeSurfaces()` 均保留在 `ui/builders/`，供将来「多图谱对比」这类结果区编排使用

### 图谱检索范围修正：按文档取子图（2026-10-28，方案 C）

**拆词启发式的问题**：`slice(0,2)` 是位置切割，不是分词。实测噪音率很高：

| 原词 | 原词命中 | 拆出的词 | 拆词命中 | 噪音 |
|---|---|---|---|---|
| 高炉炼铁 | 0 实体 0 关系 | 高炉 | 5 实体 5 关系 | 全部相关（**救场**） |
| 生产全流程质量数据在线监控 | 1 实体 1 关系 | 生产 | 5 实体 5 关系 | **4/5 是别的概念**（安全生产 / 智能生产 / 生产制造） |
| 钢铁工艺数据分析 | 1 实体 1 关系 | 钢铁 | 5 实体 5 关系 | 命中「钢铁+人工智能」「钢铁企业」 |

最坏的后果不是「没有图」，而是「**误导性证据**」—— 噪音实体的关系被拼进 `【知识图谱关联】` 注入上下文，模型可能基于无关关系编答案。

**改用方案 C**：新增 `KgService.getSubgraphByDocIds(docIds)` —— 取「已命中文档提及的实体」作种子，再向外一跳取关系。相关性交给文档检索（BM25 + rerank），图谱只负责展开。**拆词降级为兜底**（文档 0 命中 / 文档内无实体时才用）。

**实施中踩的坑**：关系查询最初写成 `a.name IN $names AND b.name IN $names`（只找种子之间的边），实测 `docs=5 → 实体=20 关系=0` —— 5 篇文档主题各异（钢铁 / 考勤 / 立项），它们的实体互相孤立，内部根本没有边。改成 `OR` 允许一端在种子之外，并把边端点补进实体表，才拿到关系。

**代价**：图谱预检从并行改为**串行在知识库检索之后**（需要 docId 才能限定范围），多一次本地 Neo4j 查询（几十毫秒）。

**实测**：`图谱预检(按文档) docs=5 → 实体=33 关系=20`，时间轴显示「图谱 · 已检索知识图谱 · 20」，同轮知识库卡片命中 5 篇。

### 待做

- **P1 `render_ui` 工具**（见第六节）

### P1（约 1.5 天）render_ui 工具

1. `render-ui.ts` 工具 + 预算计数（单列 1 次）
2. prompt 注入精简目录
3. 校验失败 → 回传单组件 schema → 允许 1 次重试
4. golden set：10 条典型问题，断言 surface 结构可快照

### P2（不做，仅记录）

- 开放式 HTML surface（`GeneratedView` 逃生舱口）
- surface 流式 patch
- 迁移到 A2UI 正式协议

---

## 九、已知坑

1. ~~**`data` 指针不要支持表达式**~~ → MVP 干脆不启用指针，见 3.3。将来启用时也只做路径取值，不做 `@data.items.filter(...)`——一旦允许表达式就等于引入一门 DSL，校验和注入风险都翻倍。
2. **`surfaceId` 用雪花 ID**，与项目既有 ID 规范一致，不要用自增或随机字符串。
3. **DB 列全部 snake_case**，TS 属性 camelCase——surface 落库时（若走方案 A）注意 `TypeORM` 的 `@Column({ name: 'surfaces' })`，且 `jsonb` 不需要 transformer。
4. **不要在前端做 props 校验**。前端只做 `REGISTRY` 白名单 + try/catch 降级；校验职责在后端。否则两套 zod 必然漂移。
5. **`AiChatPanel.vue` 里的 `text-delta` 累积逻辑不要动**。surface 和流式文本是两条并行路径，回答正文仍然走 `text-delta`，surface 只负责结构化结果，不要试图用 surface 承载正文。
6. **双写期长度**。旧事件保留到前端全量切完再删，中间不要顺手"清理"——`AiProcessTimeline.vue` 也消费了 `data-*` 事件，删之前先确认它已迁移。
