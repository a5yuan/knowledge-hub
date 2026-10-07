import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/** dashscope 原生重排端点（非 OpenAI 兼容协议，模型走 RERANK_MODEL 环境变量） */
const DEFAULT_RERANK_URL =
  'https://dashscope.aliyuncs.com/api/v1/services/rerank/text-rerank/text-rerank';
const DEFAULT_RERANK_MODEL = 'qwen3.7-text-rerank';
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
        return null;
      }
      const data = (await resp.json()) as { output?: { results?: RerankResult[] } };
      const results = data.output?.results;
      if (!Array.isArray(results)) {
        this.logger.warn(`重排接口响应格式异常 model=${model}，降级为 RRF 排序`);
        return null;
      }
      return results;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.warn(`重排接口调用失败 model=${model}，降级为 RRF 排序: ${msg}`);
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  constructor(private readonly config: ConfigService) {}
}
