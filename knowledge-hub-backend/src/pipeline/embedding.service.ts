import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OpenAIEmbeddings } from '@langchain/openai';
import { TracingService } from '../observability/tracing.service';

/**
 * 字符 → token 的粗略换算（工单 24 §s09）。
 *
 * DashScope 的 embedding / rerank 接口**不返回 token 用量**，只能估。
 * 取 1.5 字符/token 是按中文文本估的（qwen 分词器中文约 1.5 字符/token）；
 * 英文为主时该系数会高估约 2 倍。所以上报里必须带 `estimated: true`，
 * 报告里也要把「实测」和「估算」分列，不合并成一个总数。
 */
const CHARS_PER_TOKEN = 1.5;

/** 按字符数估算 token（四舍五入到整数，至少 1） */
export function estimateTokens(text: string): number {
  const chars = text.trim().length;
  if (!chars) return 0;
  return Math.max(1, Math.round(chars / CHARS_PER_TOKEN));
}

/**
 * 向量化服务（对应架构图"向量化(生成向量)"）
 * 直接使用 LangChain OpenAIEmbeddings，经 OpenAI 兼容端点调用（dashscope compatible-mode）
 */
@Injectable()
export class EmbeddingService {
  private readonly logger = new Logger(EmbeddingService.name);
  private client?: OpenAIEmbeddings;
  private dims = 1024;

  constructor(
    private readonly config: ConfigService,
    private readonly tracing: TracingService,
  ) {}

  /** 懒初始化客户端（首次调用时读取配置） */
  private getClient(): OpenAIEmbeddings {
    if (this.client) return this.client;
    const baseUrl = this.config.get<string>('EMBEDDING_BASE_URL');
    const model = this.config.get<string>('EMBEDDING_MODEL');
    const apiKey = this.config.get<string>('OPENAI_API_KEY');
    if (!baseUrl || !model || !apiKey) {
      throw new Error('向量化配置缺失，需设置 EMBEDDING_BASE_URL / EMBEDDING_MODEL / OPENAI_API_KEY');
    }
    this.dims = Number(this.config.get<number>('EMBEDDING_DIMS', 1024));
    this.client = new OpenAIEmbeddings({
      openAIApiKey: apiKey,
      modelName: model,
      batchSize: 10,
      configuration: { baseURL: baseUrl },
    });
    return this.client;
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (!texts.length) return [];
    const client = this.getClient();
    const vectors = await client.embedDocuments(texts);
    for (const v of vectors) {
      if (v.length !== this.dims) {
        throw new Error(`向量维度不符 期望=${this.dims} 实际=${v.length}`);
      }
    }
    // 工单 24 §s09：接口不返回 usage，按输入字符估算（estimated=true）；不在对话上下文里则静默丢弃。
    // 可选链同 rerank：采集属旁路，不能因 tracing 缺失影响向量化结果。
    this.tracing?.recordUsage?.('embedding', {
      model: this.config.get<string>('EMBEDDING_MODEL', ''),
      input: texts.reduce((sum, t) => sum + estimateTokens(t), 0),
      output: 0,
      estimated: true,
    });
    this.logger.log(`向量化完成 条数=${vectors.length} 维度=${this.dims}`);
    return vectors;
  }
}
