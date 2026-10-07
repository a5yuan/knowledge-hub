import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TracingService } from '../observability/tracing.service';

/** 记忆命中（layer 按图2 双层：user=用户层长期 / session=当前会话） */
export interface Mem0Hit {
  text: string;
  score: number;
  layer: 'user' | 'session';
}

/** Mem0 请求超时 */
const MEM0_TIMEOUT_MS = 8000;
/** 记忆召回相关度下限（实测跨语言查询得分偏低且噪声大：相关 ~0.16、无关可达 0.3+，故取低阈值 + top5，噪声由消费端 LLM 消化） */
const MEM0_SCORE_MIN = 0.1;
/** 单次召回注入上限 */
const MEM0_TOP_K = 5;

/**
 * Mem0 Platform REST 客户端（工单 10，图2 长期记忆）：
 * - fetch 零新依赖（对齐 Tavily 先例），Authorization: Token
 * - 未配 MEM0_API_KEY → available=false，全部方法短路返回，调用方无需判空
 * - 接口形状经真实 key 探活验证（2026-09-23）：
 *   add=POST /v1/memories/（异步 PENDING）；search=POST /v2/memories/search/（filters）
 *   列表=POST /v2/memories/（filters）；单条删=DELETE /v1/memories/{id}/（v2 批量 DELETE 不允许）
 */
@Injectable()
export class Mem0Service {
  private readonly logger = new Logger(Mem0Service.name);
  private readonly apiKey: string;
  private readonly baseUrl: string;

  constructor(
    config: ConfigService,
    private readonly tracing: TracingService,
  ) {
    this.apiKey = config.get<string>('MEM0_API_KEY') ?? '';
    this.baseUrl = (
      config.get<string>('MEM0_BASE_URL') || 'https://api.mem0.ai'
    ).replace(/\/+$/, '');
  }

  get available(): boolean {
    return !!this.apiKey;
  }

  /**
   * 记忆检索（图3 第3步，始终执行）：按 user_id 全量召回，再按 session_id 归层——
   * null=用户层；=当前会话=会话层；其他会话的记忆剔除（会话隔离）
   */
  async search(
    query: string,
    userId: string,
    sessionId?: string,
  ): Promise<Mem0Hit[]> {
    if (!this.available) return [];
    // 工单 13：记忆召回单独观察（外部 HTTP 调用，非 LangChain）
    return this.tracing.withSpan(
      'mem0-search',
      { input: { query }, metadata: { userId } },
      async (update) => {
        const hits = await this.requestHits(query, userId, sessionId);
        update({ output: { hits: hits.length } });
        return hits;
      },
    );
  }

  /** 实际召回（图3 第3步）：按 user_id 全量召回后按 session_id 归层；异常降级为空 */
  private async requestHits(
    query: string,
    userId: string,
    sessionId?: string,
  ): Promise<Mem0Hit[]> {
    try {
      const data = await this.request<
        Array<{
          memory?: string;
          text?: string;
          score?: number;
          session_id?: string | null;
        }>
      >('POST', '/v2/memories/search/', {
        query,
        filters: { user_id: userId },
      });
      const hits: Mem0Hit[] = [];
      for (const m of Array.isArray(data) ? data : []) {
        const text = m.memory ?? m.text;
        const score = Number(m.score ?? 0);
        if (typeof text !== 'string' || !text.trim() || score < MEM0_SCORE_MIN)
          continue;
        if (m.session_id) {
          if (m.session_id !== sessionId) continue;
          hits.push({ text, score, layer: 'session' });
        } else {
          hits.push({ text, score, layer: 'user' });
        }
      }
      return hits.sort((a, b) => b.score - a.score).slice(0, MEM0_TOP_K);
    } catch (err) {
      this.logger.warn(
        `Mem0 search 降级: ${err instanceof Error ? err.message : err}`,
      );
      return [];
    }
  }

  /** 写入记忆（图3 第6步异步；平台后台抽取，写入即返回 PENDING） */
  async add(
    messages: Array<{ role: string; content: string }>,
    userId: string,
    runId?: string,
  ): Promise<void> {
    if (!this.available || messages.length === 0) return;
    try {
      await this.request('POST', '/v1/memories/', {
        messages,
        user_id: userId,
        ...(runId ? { run_id: runId } : {}),
      });
    } catch (err) {
      this.logger.warn(
        `Mem0 add 降级: ${err instanceof Error ? err.message : err}`,
      );
    }
  }

  /** 按会话清理记忆（图2：删除会话仅清会话层，用户层保留）＝v2 列表 + v1 逐条删 */
  async deleteAllByRun(userId: string, runId: string): Promise<void> {
    if (!this.available) return;
    try {
      const list = await this.request<Array<{ id?: string }>>(
        'POST',
        '/v2/memories/',
        {
          filters: { user_id: userId, run_id: runId },
          page: 1,
          page_size: 100,
        },
      );
      const ids = (Array.isArray(list) ? list : [])
        .map((m) => m.id)
        .filter((id): id is string => !!id);
      await Promise.all(
        ids.map((id) =>
          this.request('DELETE', `/v1/memories/${id}/`).catch((err: unknown) =>
            this.logger.warn(
              `Mem0 单条删除失败 id=${id}: ${err instanceof Error ? err.message : err}`,
            ),
          ),
        ),
      );
    } catch (err) {
      this.logger.warn(
        `Mem0 会话层清理降级: ${err instanceof Error ? err.message : err}`,
      );
    }
  }

  /** 统一请求（超时快速失败；非 2xx 抛错由上层降级） */
  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), MEM0_TIMEOUT_MS);
    try {
      const resp = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Token ${this.apiKey}`,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: ctrl.signal,
      });
      if (!resp.ok) throw new Error(`mem0 ${path} → ${resp.status}`);
      const text = await resp.text();
      return (text ? JSON.parse(text) : undefined) as T;
    } finally {
      clearTimeout(timer);
    }
  }
}
