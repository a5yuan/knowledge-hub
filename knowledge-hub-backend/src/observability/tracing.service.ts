import { Injectable, Logger } from '@nestjs/common';
import { AsyncLocalStorage } from 'node:async_hooks';
import { CallbackHandler } from '@langfuse/langchain';
import { startActiveObservation, updateActiveObservation, getActiveTraceId, LangfuseOtelSpanAttributes } from '@langfuse/tracing';
import { isTracingEnabled } from './tracing';

/** 一次 AI 对话的追踪句柄（tracing 未启用时为 no-op，调用方无需判空） */
export interface ChatTrace {
  /** LangChain 回调（惰性创建；会话确定后首次调用即带上 session 分组） */
  callbacks: () => CallbackHandler[];
  /** 会话 id 确定后登记（trace 按会话分组，便于 Sessions 视图查看多轮） */
  setSession: (sessionId: string) => void;
  /** 记录最终输出（回答正文 + 引用条数）；error 非空时标记 trace 为 ERROR 级 */
  finish: (output: { answer: string; sources: number }, error?: string) => void;
  /** 当前 trace id（tracing 未启用时为 undefined）；供上层回传给调用方做评测关联 */
  traceId: () => string | undefined;
}

const NOOP_TRACE: ChatTrace = {
  callbacks: () => [],
  setSession: () => { },
  finish: () => { },
  traceId: () => undefined,
};

const noopUpdate = (): void => { };

/**
 * 一次调用的 token 用量（工单 24 §s09 成本）。
 * `estimated=true` 表示不是接口返回的真实用量，而是按字符数估算 ——
 * DashScope 的 embedding / rerank 接口不返回 token，只能估。两者必须分开标注，不能混算。
 */
export interface UsageEntry {
  /** 环节：plan / grade / answer / memory / suggestions / embedding / rerank */
  stage: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
  estimated: boolean;
}

/**
 * Langfuse 追踪服务（工单 13）：把一次 AI 对话包成单个 trace（agent 类型），
 * 其下的 LangChain 调用（Agent 循环 / 意图路由 / 切题评估 / 记忆抽取 / suggestions）
 * 由 CallbackHandler 自动嵌套，检索/向量化/重排/记忆等非 LangChain 调用用显式 span 包裹。
 *
 * 两条降级保证：
 * 1. LANGFUSE_ENABLED=false 或 SDK 未就绪时全部方法走 no-op，主链路行为与现状完全一致；
 * 2. 任一追踪调用异常都被吞掉记日志，绝不影响业务返回。
 */
@Injectable()
export class TracingService {
  private readonly logger = new Logger(TracingService.name);
  /** 当前异步上下文的回调（供 buildModel / buildUtilityModel 直接读取，免去逐层传参；ALS 天然并发安全） */
  private readonly als = new AsyncLocalStorage<{
    cbs: CallbackHandler[];
    /** 本轮对话的 token 用量累计；未开启 ENABLE_USAGE_CAPTURE 时为 null（不分配、不收集） */
    usage: UsageEntry[] | null;
  }>();
  readonly enabled = isTracingEnabled();
  /**
   * 用量采集开关（工单 24 §生产代码改动）：与 Langfuse 追踪**互相独立**。
   * 关着时：不传 `stream_options`、不收集、不下发 `usage` 事件 —— 链路与改动前逐字节一致。
   */
  readonly usageEnabled = process.env.ENABLE_USAGE_CAPTURE === 'true';

  /** 当前上下文中的 LangChain 回调；未启用时为空数组 */
  current(): CallbackHandler[] {
    return this.als.getStore()?.cbs ?? [];
  }

  /**
   * 记录一次调用的 token 用量。
   * 未开启采集、或当前异步上下文不在一次对话里（例如 pipeline 后台切片调 embedding）→ 静默丢弃。
   */
  recordUsage(
    stage: string,
    u: { model?: string; input?: number; output?: number; estimated?: boolean },
  ): void {
    if (!this.usageEnabled) return;
    const store = this.als.getStore();
    if (!store?.usage) return;
    try {
      store.usage.push({
        stage,
        model: u.model ?? '',
        input_tokens: Math.max(0, Math.round(u.input ?? 0)),
        output_tokens: Math.max(0, Math.round(u.output ?? 0)),
        estimated: u.estimated === true,
      });
    } catch {
      /* 采集失败绝不影响业务 */
    }
  }

  /** 本轮对话累计用量（未开启采集时为空数组） */
  usageSnapshot(): UsageEntry[] {
    return this.als.getStore()?.usage ?? [];
  }

  /**
   * 把一次对话包进单个 trace（agent 类型），`fn` 内的 LangChain 观察自动嵌套其下。
   * 未启用时直接执行 `fn(NOOP_TRACE)`，不做任何 OTel 调用。
   */
  async runChat<T>(
    opts: { userId: string; question: string; tags?: string[] },
    fn: (trace: ChatTrace) => Promise<T>,
  ): Promise<T> {
    // holder 必须在 tracing 开关判断**之前**建好：用量采集不依赖 Langfuse，
    // LANGFUSE_ENABLED=false 时也要能用 ALS 承载本轮 usage 累计（工单 24 §s09）
    const holder = {
      cbs: [] as CallbackHandler[],
      usage: this.usageEnabled ? ([] as UsageEntry[]) : null,
    };
    if (!this.enabled) return this.als.run(holder, () => fn(NOOP_TRACE));
    let handler: CallbackHandler | undefined;
    // trace 级属性（user/session）在 Langfuse v4 中取自「根观察」，故直接写在根 span 上；
    // 用 OTel 属性而非 propagateAttributes，是为了支持 sessionId 在会话创建后才确定（可后置写入）
    let rootSpan: { setAttribute: (key: string, value: unknown) => void } | undefined;
    const setAttr = (key: string, value: unknown): void => {
      try {
        rootSpan?.setAttribute(key, value);
      } catch {
        /* 追踪属性写入失败不影响业务 */
      }
    };

    const trace: ChatTrace = {
      callbacks: () => {
        if (!handler) {
          try {
            // handler 构造参数不写成 trace 级属性（v4 从根观察读取），故只保留 tags
            handler = new CallbackHandler({
              tags: ['ai-chat', ...(opts.tags ?? [])],
            });
          } catch (err) {
            this.logger.warn(
              `Langfuse CallbackHandler 创建失败: ${err instanceof Error ? err.message : err}`,
            );
          }
        }
        holder.cbs = handler ? [handler] : [];
        return holder.cbs;
      },
      setSession: (id) => {
        setAttr(LangfuseOtelSpanAttributes.TRACE_SESSION_ID, id);
      },
      finish: (output, error) => {
        try {
          updateActiveObservation(
            error
              ? { output, level: 'ERROR', statusMessage: error }
              : { output },
            { asType: 'agent' },
          );
        } catch (err) {
          this.logger.warn(
            `Langfuse trace 输出登记失败: ${err instanceof Error ? err.message : err}`,
          );
        }
      },
      traceId: () => {
        try {
          return getActiveTraceId();
        } catch {
          return undefined;
        }
      },
    };

    return this.als.run(holder, () =>
      startActiveObservation(
        'ai-chat',
        async (agent) => {
          rootSpan = agent.otelSpan;
          // 只登记用户问题作为 trace 输入（避免把配置/凭据等无关参数带进 trace）
          agent.update({
            input: opts.question,
            metadata: { userId: opts.userId },
          });
          setAttr(LangfuseOtelSpanAttributes.TRACE_USER_ID, opts.userId);
          return fn(trace);
        },
        { asType: 'agent' },
      ),
    );
  }

  /** 包裹一次检索（混合召回 + 融合 + 精排），产出 retriever 观察 */
  async withRetriever<T>(
    name: string,
    attrs: { input?: unknown; metadata?: Record<string, unknown> },
    fn: (
      update: (a: {
        output?: unknown;
        metadata?: Record<string, unknown>;
      }) => void,
    ) => Promise<T>,
  ): Promise<T> {
    if (!this.enabled) return fn(noopUpdate);
    return startActiveObservation(
      name,
      async (obs) => {
        obs.update(attrs);
        return fn((a) => {
          try {
            obs.update(a);
          } catch {
            /* 忽略 */
          }
        });
      },
      { asType: 'retriever' },
    );
  }

  /** 包裹一次向量化，产出 embedding 观察 */
  async withEmbedding<T>(
    name: string,
    attrs: { input?: unknown; metadata?: Record<string, unknown> },
    fn: (
      update: (a: {
        output?: unknown;
        metadata?: Record<string, unknown>;
      }) => void,
    ) => Promise<T>,
  ): Promise<T> {
    if (!this.enabled) return fn(noopUpdate);
    return startActiveObservation(
      name,
      async (obs) => {
        obs.update(attrs);
        return fn((a) => {
          try {
            obs.update(a);
          } catch {
            /* 忽略 */
          }
        });
      },
      { asType: 'embedding' },
    );
  }

  /** 包裹一次外部调用（精排 / 记忆召回等），产出通用 span 观察 */
  async withSpan<T>(
    name: string,
    attrs: { input?: unknown; metadata?: Record<string, unknown> },
    fn: (
      update: (a: {
        output?: unknown;
        metadata?: Record<string, unknown>;
      }) => void,
    ) => Promise<T>,
  ): Promise<T> {
    if (!this.enabled) return fn(noopUpdate);
    return startActiveObservation(
      name,
      async (obs) => {
        obs.update(attrs);
        return fn((a) => {
          try {
            obs.update(a);
          } catch {
            /* 忽略 */
          }
        });
      },
      { asType: 'span' },
    );
  }
}
