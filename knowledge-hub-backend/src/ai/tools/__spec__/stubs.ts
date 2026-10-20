/**
 * 工具层测试桩（工单 23）。
 *
 * 目的：让 4 个工具能在**没有 Express、没有 RAG/Neo4j、没有模型**的情况下被断言。
 * 这正是工单 23 的核心价值 —— 抽取前这些分支只能靠起全套环境手工验。
 */
import type { Logger } from '@nestjs/common';
import { createSourceRegistry } from '../source-registry';
import { EXCERPT_LEN } from '../constants';
import type {
  SourceDraft,
  SourceRegistry,
  ToolDeps,
  ToolEventSink,
} from '../types';

/** 过程事件记录（断言 status 被调用几次、传了什么） */
export interface StatusCall {
  stage: string;
  text: string;
}

export interface DepsHarness {
  deps: ToolDeps;
  /** 引用池（工具登记后的结果） */
  store: SourceDraft[];
  registry: SourceRegistry;
  /** 已下发的 data-status 过程事件 */
  statuses: StatusCall[];
  /** logger.warn 收到的消息 */
  warnings: string[];
}

export interface HarnessOptions {
  /** rag.search 的返回或抛错 */
  search?: (
    query: string,
    topK: number,
    rerank: boolean,
    scope?: unknown,
  ) => Promise<{
    items: Array<{ doc_id: string; doc_title: string; content: string }>;
  }>;
  /** kg.searchGraph 的返回或抛错 */
  searchGraph?: (
    query: string,
    entityType?: string,
    limit?: number,
  ) => Promise<{
    entities: Array<{
      name: string;
      type: string;
      description?: string | null;
    }>;
    edges: Array<{
      sourceName: string;
      sourceType: string;
      relation: string;
      targetName: string;
      targetType: string;
    }>;
  }>;
  /** 切题评估桩 */
  grader?: (
    question: string,
    chunks: Array<{ title: string; content: string }>,
  ) => Promise<Array<'on_topic' | 'partial' | 'off_topic'> | null>;
  /** Tavily key（null = 未配置） */
  tavilyApiKey?: string | null;
  /** 复用已有引用池（测编号连续性时用） */
  store?: SourceDraft[];
}

/** 构造一套全桩依赖 */
export function makeHarness(opts: HarnessOptions = {}): DepsHarness {
  const store = opts.store ?? [];
  const registry = createSourceRegistry(store);
  const statuses: StatusCall[] = [];
  const warnings: string[] = [];

  const events: ToolEventSink = {
    status: (stage, text) => {
      statuses.push({ stage, text });
    },
  };

  const logger = {
    warn: (msg: string) => {
      warnings.push(msg);
    },
  } as unknown as Pick<Logger, 'warn'>;

  const deps: ToolDeps = {
    rag: {
      search: opts.search ?? (() => Promise.resolve({ items: [] })),
    } as unknown as ToolDeps['rag'],
    kg: {
      searchGraph:
        opts.searchGraph ??
        (() => Promise.resolve({ entities: [], edges: [] })),
    } as unknown as ToolDeps['kg'],
    grader:
      opts.grader ??
      ((_q, chunks) => Promise.resolve(chunks.map(() => 'on_topic' as const))),
    sources: registry,
    events,
    logger,
    config: {
      excerptLen: EXCERPT_LEN,
      tavilyApiKey:
        opts.tavilyApiKey === null
          ? undefined
          : (opts.tavilyApiKey ?? 'test-key'),
    },
  };

  return { deps, store, registry, statuses, warnings };
}
