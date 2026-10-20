/**
 * Agent 工具层契约（工单 23）。
 *
 * 设计边界：
 * - 工具**只依赖本文件的类型**，不 import `express` 的 `Response`（验收项 2）
 * - SSE 的「过程事件」经 `ToolEventSink` 出口；「结果事件」仍由编排层消费工具返回值下发，
 *   本层不碰（工单 23 §二 关键发现二）
 * - 引用编号 `n` 必须在工具内部产生并立即拼进 `content`，因此注入的是 `SourceRegistry`
 *   而不是裸数组 —— 若改成「返回草稿、编排层统一注册」，工具拼字符串时拿不到编号
 */
import type { Logger } from '@nestjs/common';
import type { RagSearchService } from '../../rag/rag-search.service';
import type { KgService } from '../../kg/kg.service';
import type { AiSourceV2 } from '../ai-session.service';

/** 引用来源草稿（与持久化类型同源，去掉 index —— 编号在登记时确定） */
export type SourceDraft = Omit<AiSourceV2, 'index'>;

/** 切题评估三态（11 号工单） */
export type ChunkGrade = 'on_topic' | 'partial' | 'off_topic';

/** 切题评估结果：整体态可能是 none（无资料） */
export type OverallGrade = 'none' | ChunkGrade;

/** 知识库检索条目（retrieve_knowledge 返回） */
export interface KnowledgeItem {
  documentId: string;
  documentTitle: string;
  excerpt: string;
  /** 完整正文（仅切题保留的条目才有；0 命中 / 全不切题时不存在） */
  content?: string;
}

/** Web 检索结果（web_search 返回，前端只渲染标题与链接） */
export interface WebResult {
  title: string;
  url: string;
}

/** 图谱实体（retrieve_graph 返回，前端 mini 力导图节点） */
export interface GraphEntity {
  name: string;
  type: string;
  description?: string;
}

/** 图谱关系（retrieve_graph 返回，前端 mini 力导图边） */
export interface GraphRelation {
  source: string;
  relation: string;
  target: string;
}

/**
 * 工具统一返回值。
 *
 * 字段按工具取子集：
 * - `retrieve_knowledge` → `grade` / `items`
 * - `rewrite_query` → `rewrite`（改写后的检索词）
 * - `web_search` → `results`
 * - `retrieve_graph` → `entities` / `relations` / `degraded`
 */
export interface ToolResult {
  /** 短描述，仅供日志与 trace */
  summary: string;
  /** 进入 ToolMessage 的正文（含 [n] 编号） */
  content: string;
  /** 仅 retrieve_knowledge */
  grade?: OverallGrade;
  /** 仅 retrieve_knowledge */
  items?: KnowledgeItem[];
  /** 仅 rewrite_query：改写后的检索词 */
  rewrite?: string;
  /** 仅 web_search */
  results?: WebResult[];
  /** 仅 retrieve_graph */
  entities?: GraphEntity[];
  /** 仅 retrieve_graph */
  relations?: GraphRelation[];
  /** 降级标记（目前仅 retrieve_graph 置 true，语义保持原样） */
  degraded?: boolean;
}

/** 过程事件出口：覆盖原实现里 3 处 `this.emit(res, 'data-status', ...)` */
export interface ToolEventSink {
  status(stage: string, text: string): void;
}

/**
 * 引用登记表。
 *
 * `register` 与 `push` 的差别是**刻意保留的既有不一致**：
 * - `register` 按 `kind + (ref|url)` 去重并返回全局编号（知识库 / 图谱用）
 * - `push` 直接追加、不去重（web_search 现状，`:1268`）
 *
 * 工单 23 承诺「零行为变更」，所以 web 的去重对齐拆到后续工单（§四 步骤 7）。
 */
export interface SourceRegistry {
  /** 去重登记，返回全局编号（从 1 开始） */
  register(draft: SourceDraft): number;
  /** 不去重追加，返回新长度 */
  push(draft: SourceDraft): number;
  /** 底层数组（编排层收尾时读取） */
  all(): SourceDraft[];
}

/** 工具运行依赖（全部由编排层注入，工具不自持状态） */
export interface ToolDeps {
  rag: Pick<RagSearchService, 'search'>;
  kg: Pick<KgService, 'searchGraph'>;
  /** 切题评估（service 的 gradeChunks）：返回 null 表示评估降级、按全量可用处理 */
  grader: (
    question: string,
    chunks: Array<{ title: string; content: string }>,
  ) => Promise<ChunkGrade[] | null>;
  sources: SourceRegistry;
  events: ToolEventSink;
  logger: Pick<Logger, 'warn'>;
  config: {
    /** 引用摘要截断长度，默认 EXCERPT_LEN */
    excerptLen: number;
    /** Tavily key；为空则 web 工具直接返回「未配置」 */
    tavilyApiKey?: string;
  };
}
