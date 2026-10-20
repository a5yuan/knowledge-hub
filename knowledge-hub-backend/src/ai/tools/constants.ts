/**
 * 工具层常量（工单 23）。
 *
 * 从 `ai-agent.service.ts` 下沉而来 —— 目的是让「工具用到的数字」只有一个来源，
 * 后续 `test/eval/agent-trace.mjs` 可以从编译产物或本文件同步，不再手抄（见工单 23 §八 TODO）。
 *
 * ⚠️ 预算类常量（`MAX_TOOL_CALLS` 等）**不在本文件**：它们属于编排层的门控策略，
 * 不是工具自身的参数，留在 `ai-agent.service.ts`。
 */

/** 引用摘要截断长度（知识库 / Web / 图谱共用） */
export const EXCERPT_LEN = 120;

/** 图谱检索实体上限（防上下文膨胀） */
export const GRAPH_ENTITY_LIMIT = 8;

/** 图谱检索关系上限 */
export const GRAPH_RELATION_LIMIT = 10;

/** Tavily 请求超时 */
export const TAVILY_TIMEOUT_MS = 8000;

/** Web 正文进 content 时的截断长度（原文硬编码 300，收拢为常量便于对齐） */
export const WEB_CONTENT_SLICE = 300;

/** 知识库正文进 content 时的截断长度 */
export const KNOWLEDGE_CONTENT_SLICE = 500;
