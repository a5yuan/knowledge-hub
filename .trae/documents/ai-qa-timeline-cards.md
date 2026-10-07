---
status: historical
updated: 2026-09-24
---

# AI 知识问答：按 data-xx 事件渲染时间线多卡片 UI

## Summary

将 AI 智能问答回答上方的过程区从「单块折叠面板（AiProcessBlock）」整体重构为参考图中的「左侧圆点时间线 + 每个事件一张独立卡片」布局。后端 v2 SSE 协议已发送全部所需事件（`data-plan` / `reasoning-*` / `data-web-search` / `data-retrieve` / `data-memory` / `data-status`），本次为**纯前端改造**，不改后端、不改 `ai.ts` 协议解析。

卡片类型与事件对应：

| 卡片 | 事件 | 图中样式 |
| --- | --- | --- |
| 意图识别卡 | `data-plan` | `[意图识别]` 标签 + 动作标题；正文两行：建议检索词、范围（知识库/联网 chips，按意图高亮） |
| 思考过程卡 | `reasoning-start/delta/end` | 「思考过程」+ 状态字（已完成），可展开看思考全文；每轮迭代一张，可出现多张 |
| 联网卡 | `data-web-search` | `[联网]` 标签 +「已搜索公开信息」+ 右侧结果计数，可展开结果列表 |
| 知识库卡 | `data-retrieve` | `[知识库]` 标签 +「已检索知识库文档」+ 计数，可展开文档列表 |
| 记忆卡 | `data-memory` | `[记忆]` 标签 +「已回忆 N 条记忆」+ 计数，可展开记忆列表 |
| 状态行 | `data-status` | 非卡片：流式期间时间线末尾一行 spinner + 文本，流结束即消失 |

## Current State Analysis

- 编排层 [Index.vue](file:///d:/桌面/AI项目/企业级知识库/knowledge-hub-front/src/views/ai-qa/Index.vue)：
  - `processEntries: AiProcessEntry[]`（L126）+ `reasoningText: string`（L127）两个扁平状态；
  - 各 handler（L166-207）把事件 push 进 `processEntries`，reasoning 增量拼进单一字符串 → **丢失事件顺序**（reasoning 与工具卡片无法交错），无法支撑图中「思考→联网→思考」多卡片时间线。
- 展示层 [AiChatPanel.vue](file:///d:/桌面/AI项目/企业级知识库/knowledge-hub-front/src/views/ai-qa/components/AiChatPanel.vue)：流式气泡（L150）与完成态挂最后一条 AI 消息（L121）两处引用 `AiProcessBlock`。
- [AiProcessBlock.vue](file:///d:/桌面/AI项目/企业级知识库/knowledge-hub-front/src/views/ai-qa/components/AiProcessBlock.vue)：单个「✓ 已完成」折叠头 + body 内 reasoning 块 + 条目列表，整体替换。
- SSE 层 [ai.ts](file:///d:/桌面/AI项目/企业级知识库/knowledge-hub-front/src/api/ai.ts) L162-214 已按 `payload.type` 分发全部事件，handlers 齐全（`onPlan/onRetrieve/onWebSearch/onMemory/onStatus/onReasoningStart/Delta/End`），**无需改动**。
- 后端 [ai-agent.service.ts](file:///d:/桌面/AI项目/企业级知识库/knowledge-hub-backend/src/ai/ai-agent.service.ts)：`data-plan` L154 `{intent, suggestedTerms}`；`data-retrieve` L327 `{query, items:[{documentId, documentTitle, excerpt}]}`；`data-web-search` L329 `{query, results:[{title,url}]}`；`data-memory` L180 `{memories:[{layer, text}]}`；`data-status` stage ∈ plan/memory/retrieve/web/grade/rewrite；reasoning 每轮迭代独立 `reasoning-start/end`（L226-251）→ 多段思考成立。意图枚举：`chitchat/preference/knowledge/web/knowledge_then_web`。
- 引用范围已核实：`AiProcessBlock/AiProcessEntry` 仅被上述 3 个文件引用。
- 样式约定：无 tailwind，SFC `<style scoped>` 原生 CSS；element-plus 2.9（el-tag/el-icon 可用）；卡片 `1px solid #ececec; radius 8px`；主题色 `var(--el-color-primary)`。

## Proposed Changes

只动 `knowledge-hub-front` 三个文件：**新建 1、修改 2、删除 1**。

### 1. 新建 `src/views/ai-qa/components/AiProcessTimeline.vue`（替代 AiProcessBlock）

**类型定义**（`<script lang="ts">` 块导出，沿用 AiProcessBlock 的导出惯例）：

```ts
export type AiTimelineItem =
  | { kind: 'plan'; intent: string; suggestedTerms: string[] }
  | { kind: 'reasoning'; text: string; done: boolean; collapsed: boolean }
  | { kind: 'retrieve'; query: string; items: Array<{ title: string; excerpt?: string }>; done: boolean; collapsed: boolean }
  | { kind: 'web'; query: string; results: Array<{ title: string; url?: string }>; done: boolean; collapsed: boolean }
  | { kind: 'memory'; memories: Array<{ layer: 'user' | 'session'; text: string }>; done: boolean; collapsed: boolean }
```

`collapsed` 直接放进条目数据（本地临时数据、随流重置），由父组件维护，避免 watch/Set 索引管理。

**Props**：`{ items: AiTimelineItem[]; statusText: string; streaming: boolean }`。

**模板结构**：

```
<div class="tl">                          <!-- 时间线容器 -->
  <div v-for="item" class="tl-row">
    <div class="tl-rail">                 <!-- 左侧圆点 + 竖向连接线 -->
      <span class="dot" :class="{ active: streaming && 是最后一个条目 }" />
    </div>
    <div class="tl-card">                 <!-- 按 item.kind 分支渲染 -->
      plan:     头部 [el-tag 意图识别 primary plain] + 动作标题(粗体)
                行「建议检索词」= terms.join('、')
                行「范围」= chips 知识库 / 联网
      reasoning:头部「思考过程」+ 右侧 done ? '已完成'(粗体) : '思考中…'
                可折叠 body：reasoning 文本(pre-wrap、灰、max-height 160px 滚动)
      web:      头部 [el-tag 联网 success light] + done ? '已搜索公开信息' : '正在搜索公开信息…'
                + 右侧灰色计数 results.length
                可折叠 body：结果标题链接列表(外链 target=_blank)
      retrieve: 头部 [el-tag 知识库 primary light] + done ? '已检索知识库文档' : '正在检索知识库…'
                + 计数；body：文档标题列表(title 属性显示 excerpt)
      memory:   头部 [el-tag 记忆 warning light] + done ? `已回忆 N 条记忆` : '正在回忆相关记忆…'
                + 计数；body：`长期/会话 · text` 行列表
    </div>
  </div>
  <div v-if="streaming && statusText" class="tl-row tl-status">  <!-- 状态行：仅流式 -->
    <span class="dot active" /> <el-icon Loading 旋转 /> {{ statusText }}
  </div>
</div>
```

交互与样式要点：

- 可折叠卡片（reasoning/web/retrieve/memory）点击头部 `item.collapsed = !item.collapsed`（emit 或直接改 props 对象字段——条目为本地临时数据，直接改最简，与现有代码风格一致）。
- 「范围」chips 由 intent 推导：`knowledge/knowledge_then_web` → 知识库高亮（el-tag primary light）；`web/knowledge_then_web` → 联网高亮（el-tag primary light）；否则两者灰色纯文本。chips 始终两个都渲染（对齐图中「知识库 | 联网」样式）。
- 动作标题映射（复用 Index.vue 已有 `INTENT_LABELS` 语义，改为动作文案）：`knowledge→知识库检索`、`web→联网搜索`、`knowledge_then_web→知识库检索 + 联网搜索`、`chitchat/preference→直接回答`。
- 圆点：最新条目且 streaming → 实心蓝点（`var(--el-color-primary)`，pulse 动画）；其余空心灰点；竖线 `#e4e7ed`。
- 卡片底色白、`1px solid #ececec`、radius 8px、`margin-bottom 8px`；标签色对齐图中：意图识别=蓝 plain、联网=浅青绿（success light）、知识库=蓝 light、记忆=暖黄（warning light）。
- 完成态与流式态复用同一组件（与现状一致：完成态挂最后一条 AI 消息上方，流式态在流式气泡内），不保留旧的外层折叠头。

### 2. 修改 `src/views/ai-qa/Index.vue`（事件编排）

- L126-128 状态替换：`processEntries`/`reasoningText` → `timeline = ref<AiTimelineItem[]>([])` + `statusText = ref('')`。
- 重置点同步替换：`onSelectSession`(L62-64)、`onCreate`(L74-76)、`onClear`(L85-87)、`onSend`(L138-140) 中的 `processEntries.value = []` / `reasoningText.value = ''` → `timeline.value = []` / `statusText.value = ''`。
- handlers 改写（L166-207）：
  - `onStatus`：`statusText.value = d.text`（不再 push 条目）。
  - `onPlan`：push `{ kind:'plan', intent, suggestedTerms }`。
  - `onReasoningStart`：push `{ kind:'reasoning', text:'', done:false, collapsed:false }` 并记 `activeReasoning` 指向该对象（deltas 必跟在其 start 后，无需 id 映射）。
  - `onReasoningDelta`：`activeReasoning.text += d.delta`。
  - `onReasoningEnd`：`activeReasoning.done = true; collapsed = true`。
  - `onRetrieve`：push `{ kind:'retrieve', query, items: d.items.map(it=>({title: it.documentTitle, excerpt: it.excerpt})), done:true, collapsed:true }`。
  - `onWebSearch`：push `{ kind:'web', query, results: d.results, done:true, collapsed:true }`。
  - `onMemory`：memories 为空跳过（保留现有行为）；否则 push `{ kind:'memory', memories, done:true, collapsed:true }`。
  - `onFinish` 与 `finally`：`statusText.value = ''`（流结束状态行消失）。
- 模板传参（L298-301）：`:process-entries`/`:reasoning-text` → `:timeline` / `:status-text`。
- import 调整：`AiProcessEntry` → `AiTimelineItem`（仍从 `./components/AiChatPanel.vue` 导入）。

### 3. 修改 `src/views/ai-qa/components/AiChatPanel.vue`

- import/再导出：`AiProcessBlock`+`AiProcessEntry` → `AiProcessTimeline`+`AiTimelineItem`（L5-9）。
- props：`processEntries`/`reasoningText` → `timeline: AiTimelineItem[]` / `statusText: string`（L21-24）。
- `hasProcess`（L67）：`props.streaming || props.timeline.length > 0`。
- 两处渲染替换（L121-122 完成态、L150 流式态）：`<AiProcessTimeline :items="timeline" :status-text="statusText" :streaming="…" />`。
- 思考面板不再经过该组件的 `reasoning` prop（思考文本在 timeline 条目内）。

### 4. 删除 `src/views/ai-qa/components/AiProcessBlock.vue`

已被 AiProcessTimeline 完全替代，无其他引用（已核实），直接删除。

## Assumptions & Decisions

1. **纯前端改造**：SSE 协议、后端、`ai.ts` 分发层均不动。
2. **时间线顺序 = 事件到达顺序**：用单一 `timeline` 数组替代「entries + 单一 reasoning 字符串」，多段思考可正确交错（图中「思考→联网→思考」）。
3. **data-status 仅流式期间显示**（用户已确认）：不落时间线，流结束清除。
4. **完成态不持久化**：与现状一致，历史会话回放（`fetchMessages`）不含过程卡片，时间线仅存在于本次流式及其后的最后一条 AI 消息上，切换/新建/清空时重置。
5. **「范围」= 意图通道**（知识库/联网 chips 按 intent 高亮），非文档可见权限（公开/团队/自己的 VisibilityScope）。
6. ** reasoning 卡默认展开→完成后自动折叠**；web/retrieve/memory 卡完成即折叠（对齐图中收起形态），均可点击展开回看。
7. 深度思考未开启时无 reasoning 事件 → 不出现思考过程卡，属预期行为。
8. 图中「回到底部」悬浮按钮、公众号水印不在本次范围。

## Verification

1. **类型/构建**：`knowledge-hub-front` 下 `npm run build`（含 `vue-tsc -b`）通过，无 AiProcessBlock 残留引用。
2. **lint**：`npm run lint` 通过。
3. **手工端到端**（后端 3000 + vite 5173，admin 登录 → AI 智能问答）：
   - 问「今天人民币兑美元汇率」（意图=web）：时间线依次出现 意图识别卡（建议检索词、范围：联网高亮）→ 思考过程卡（若开深度思考）→ 联网卡「已搜索公开信息 · 3」→ 思考过程卡 → 回答正文；流式中时间线末尾有「正在搜索网页...」状态行，结束后消失。
   - 问一个知识库问题（意图=knowledge）：出现知识库卡（计数=命中文档数），展开可见文档标题。
   - 新会话首问（有 Mem0 记忆）：出现记忆卡。
   - 切换会话/新建对话：时间线正确清空；完成后卡片可展开回看；「停止」中断不报错。
