---
status: current
updated: 2026-10-27
---

# 子系统：AI Agent 编排（`knowledge-hub-backend/src/ai/`）

改 Agent 循环、工具、预算、SSE 之前必读。

## 职责

**负责**：一次对话的完整编排 —— 意图路由 → 工具调用循环 → 预算与门控 → 引用登记 → SSE 流式下发；以及会话持久化、长期记忆（mem0）、短期记忆（memory-cache）。

**不负责**：检索本身（在 `rag/`）、图谱查询（在 `kg/`）、切片与 embedding（在 `pipeline/`）。本模块只**调用**它们。

## 不变量

1. **`ai/tools/` 里的工具只依赖 `tools/types.ts` 的类型，不 import `express`。** 依赖全部经 `ToolDeps` 注入（`rag` / `kg` / `grader` / `sources` / `events` / `logger` / `config`），工具**不自持状态**。
2. **改工具逻辑改 `tools/`，不要改 `ai-agent.service.ts`。** service 里的 `make*Tool` 只是 `tool()` 契约的薄包装。
3. **引用编号必须在工具内部产生并立即拼进 `content`。** 这是注入 `SourceRegistry` 而非裸数组的原因 —— 若改成"返回草稿、编排层统一注册"，工具拼字符串时拿不到编号。
4. **预算常量唯一来源是 `tool-denial.ts` 的 `TOOL_BUDGET_LIMITS`**：`total: 4`、`rewrite: 1`、`web: 1`、`graph: 1`。服务里的 `MAX_*` 全部引用它，不要写字面量。轮次上限 `MAX_ITERATIONS = 5`（属于编排层门控，不在 `tools/constants.ts`）。
5. **结构化拒绝三态固定**：`intent_gate` → `budget_total` → `budget_per_tool`，判断顺序与类型定义严格对应。拒绝载荷挂 `ToolMessage.additional_kwargs.tool_denial`。
6. **`data-retrieve` 事件的 item 必须同时带 `excerpt` 和 `content`。** `excerpt`（120 字）给前端卡片，`content`（完整 chunk）给 judge 与任何"判断回答是否忠于原文"的消费方。给 judge 用 `excerpt` 等于用摘要判断忠实度，结论无效。
7. **Langfuse 降级不报错。** 初始化失败、span 写入失败、flush 失败一律只记日志，不抛错、不影响业务返回。

## 依赖方向

```
ai/ ──→ rag/（RagSearchService.search）
    ──→ kg/（KgService.searchGraph）
    ──→ observability/（tracing，经 AsyncLocalStorage）

ai/tools/ ──→ 只依赖 tools/types.ts 与 tools/constants.ts
          ──✗ 不依赖 express、不依赖 ai-agent.service

其它模块不 import ai/（不存在反向依赖）
```

## 关键文件

| 文件 | 作用 |
|---|---|
| `ai-agent.service.ts` | 编排循环：意图路由 / 预算门控 / 工具调度 / SSE / 引用收尾 |
| `tools/types.ts` | **工具层契约**：`ToolDeps` / `ToolResult` / `SourceRegistry` / `ToolEventSink` |
| `tools/constants.ts` | 工具自身的数字（`EXCERPT_LEN=120`、图谱 8 实体/10 关系、Tavily 8000ms） |
| `tool-denial.ts` | `TOOL_BUDGET_LIMITS` + `buildToolDenial` + 三态拒绝类型 |
| `citation.ts` | 引用编号与来源组装 |
| `force-retrieve.ts` | 强制检索判定（绕开模型自主决定） |
| `mem0.service.ts` / `memory-cache.service.ts` | 长期 / 短期记忆 |
| `ai-session.service.ts` | 会话与消息持久化（`AiSourceV2` 定义在此） |

## 已知陷阱

### `tools/` 与 service 的边界会被无意打破

历史原因，工具的实现曾内联在 `ai-agent.service.ts`（1077 行）。23 号工单下沉到 `tools/` 时承诺**零行为变更**，所以存在刻意保留的不一致：`SourceRegistry.register` 去重、`push` 不去重（`web_search` 现状）。**不要"顺手对齐"**，那是后续工单的事。

### 22 号工单的两条编排层断言还单测不了

工具可用性契约的两条断言依赖编排层的 ModelFactory，注入重构完成前无法单测。改这块时要靠 `test/eval/` 实际跑，不要以为"没测试就是没风险"。

### 改工具描述文字会改变模型行为

工具名与描述进 prompt，属于行为参数而非注释。改描述后必须重跑评测，否则行为漂移无法归因。

## 测试方式

- 单测：`citation.spec.ts` / `force-retrieve.spec.ts` / `tool-denial.spec.ts` + `tools/__spec__/`（4 个工具各一份）
- 端到端：`pnpm run eval`（`test/eval/`，走真实 HTTP SSE，12 项指标，回写 Langfuse）
- 评测口径与踩坑见 `backend-integration/issues/24-eval-suite.md` 与 `24R-eval-retrospective.md`（本地私有）
- Langfuse 读取（v4 已下线旧端点）：`/api/public/v2/observations`、`/api/public/v3/scores`
