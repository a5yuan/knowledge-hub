import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OpenAIEmbeddings } from '@langchain/openai';

/**
 * 向量化服务（对应架构图"向量化(生成向量)"）
 * 直接使用 LangChain OpenAIEmbeddings，经 OpenAI 兼容端点调用（dashscope compatible-mode）
 */
@Injectable()
export class EmbeddingService {
  private readonly logger = new Logger(EmbeddingService.name);
  private client?: OpenAIEmbeddings;
  private dims = 1024;

  constructor(private readonly config: ConfigService) {}

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
    this.logger.log(`向量化完成 条数=${vectors.length} 维度=${this.dims}`);
    return vectors;
  }
}
