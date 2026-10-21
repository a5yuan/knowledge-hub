import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TracingService } from '../observability/tracing.service';
import { estimateTokens } from '../pipeline/embedding.service';

/** dashscope 原生重排端点（非 OpenAI 兼容协议，模型走 RERANK_MODEL 环境变量） */
const DEFAULT_RERANK_URL =
  'https://dashscope.aliyuncs.com/api/v1/services/rerank/text-rerank/text-rerank';
/**
 * 默认重排模型。
 *
 * 2026-10-21 实测（同一个 API Key，同一端点）：
 * - `qwen3.7-text-rerank` → 403 `AllocationQuota.FreeTierOnly`（免费额度用尽，且该模型不允许转付费）
 * - `gte-rerank-v2`       → 200，且返回 `usage.total_tokens`
 * - `qwen3-rerank`        → 200，同样返回 usage
 * - `gte-rerank`（v1）    → 403 `AccessDenied`（账号无权限）
 *
 * 所以默认值换成 gte-rerank-v2：能付费、有真实 usage，不会因为某个模型的免费额度用尽而静默降级。
 */
const DEFAULT_RERANK_MODEL = 'gte-rerank-v2';
const RERANK_TIMEOUT_MS = 10_000;

/** 单条重排结果：index 为传入 documents 的下标，relevance_score 为相关性得分 */
export interface RerankResult {
  index: number;
  relevance_score: number;
}

/**
 * 重排服务：调用 dashscope text-rerank 对候选片段按 query 相关性精排。
 * 失败（超时/非 200/缺配置）一律 warn 日志 + 返回 null，由调用方降级为 RRF 排序，不抛 500。
 */
@Injectable()
export class RerankService {
  private readonly logger = new Logger(RerankService.name);

  async rerank(query: string, documents: string[], topN: number): Promise<RerankResult[] | null> {
    const apiKey = this.config.get<string>('OPENAI_API_KEY');
    if (!apiKey) {
      this.logger.warn('重排配置缺失（OPENAI_API_KEY），降级为 RRF 排序');
      return null;
    }
    const url = this.config.get<string>('RERANK_API_URL', DEFAULT_RERANK_URL);
    const model = this.config.get<string>('RERANK_MODEL', DEFAULT_RERANK_MODEL);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), RERANK_TIMEOUT_MS);
    try {
      const resp = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          input: { query, documents },
          parameters: { return_documents: false, top_n: topN },
        }),
        signal: controller.signal,
      });
      if (!resp.ok) {
        const body = (await resp.text()).slice(0, 300);
        this.logger.warn(`重排接口响应异常 status=${resp.status} model=${model} body=${body}`);
        // 失败不记用量：403/400 是被拒的请求，没有计费证据。记进去只会让成本虚高
        return null;
      }
      const data = (await resp.json()) as {
        output?: { results?: RerankResult[] };
        usage?: { total_tokens?: number };
      };
      const results = data.output?.results;
      if (!Array.isArray(results)) {
        this.logger.warn(`重排接口响应格式异常 model=${model}，降级为 RRF 排序`);
        return null;
      }
      /**
       * 工单 24 §s09：dashscope rerank **确实返回 usage.total_tokens**（2026-10-21 实测，
       * 首次实现时误以为不回、按字符估算 —— 那是错的）。
       * 有真实值就用真实值；换到不回 usage 的端点时才退回估算并标 estimated。
       * rerank 没有输出 token，output 恒为 0。
       */
      const billed = Number(data.usage?.total_tokens ?? 0);
      this.tracing?.recordUsage?.('rerank', {
        model,
        input:
          billed > 0
            ? billed
            : estimateTokens(query) +
              documents.reduce((s, d) => s + estimateTokens(d), 0),
        output: 0,
        estimated: billed <= 0,
      });
      return results;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.warn(`重排接口调用失败 model=${model}，降级为 RRF 排序: ${msg}`);
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  constructor(
    private readonly config: ConfigService,
    private readonly tracing: TracingService,
  ) {}
}
