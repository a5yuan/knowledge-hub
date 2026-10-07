import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import {
  DocumentContent,
  DocumentContentDocument,
} from '../document/schemas/document-content.schema';
import { DocumentPublishPayload, MqService, QUEUE_RAG } from '../mq/mq.service';
import { VectorIndexService } from '../es/vector-index.service';
import { chunkMarkdown } from './chunker';
import { EmbeddingService } from './embedding.service';

/**
 * RAG 流水线（对应架构图"3. pipeline 模块"：监听 RabbitMQ 队列）
 * 消费(查库) → 分块 → 向量化 → 写入 ES 索引 kh_chunk
 */
@Injectable()
export class PipelineService implements OnModuleInit {
  private readonly logger = new Logger(PipelineService.name);

  constructor(
    @InjectModel(DocumentContent.name)
    private readonly contentModel: Model<DocumentContentDocument>,
    private readonly mq: MqService,
    private readonly vectorIndex: VectorIndexService,
    private readonly embedding: EmbeddingService,
    private readonly config: ConfigService,
  ) { }

  /** 监听 rag 队列（mq 模块负责重连与 ack） */
  onModuleInit(): void {
    void this.mq.consume(QUEUE_RAG, async (payload) => {
      await this.process(payload as DocumentPublishPayload);
    });
  }

  /** 单条发布消息的完整流水线，任一步抛错由 mq 模块记日志并 ack */
  private async process(payload: DocumentPublishPayload): Promise<void> {
    const docId = payload?.docId;
    if (!docId) {
      this.logger.warn('rag 消息缺少 docId，跳过');
      return;
    }

    // 1. 消费：查库取正文
    const content = await this.contentModel.findOne({ documentId: docId, deleted: false });
    if (!content || content.parse_state !== 'success' || !content.content) {
      this.logger.log(
        `文档不可分块，跳过 docId=${docId} parse_state=${content?.parse_state ?? 'not_found'}`,
      );
      return;
    }

    // 2. 分块（LangChain RecursiveCharacterTextSplitter，markdown 模式）
    const maxChars = Number(this.config.get<number>('RAG_CHUNK_MAX_CHARS', 500));
    const chunks = await chunkMarkdown(content.content, maxChars);
    if (!chunks.length) {
      this.logger.log(`正文分块为空，跳过 docId=${docId}`);
      return;
    }
    this.logger.log(`分块完成 docId=${docId} 块数=${chunks.length} maxChars=${maxChars}`);

    // 3. 向量化
    const vectors = await this.embedding.embed(chunks.map((c) => c.content));

    // 4. 写入 ES 索引 kh_chunk（09 号工单：透传可见性字段供召回阶段过滤）
    await this.vectorIndex.bulkIndexChunks(
      docId,
      payload.title ?? '',
      chunks.map((c, i) => ({ index: c.index, content: c.content, embedding: vectors[i] })),
      {
        authorId: payload.authorId ?? null,
        teamId: payload.teamId ?? null,
        status: payload.status ?? 1,
        isPublic: payload.isPublic ?? false,
      },
    );
    this.logger.log(`RAG 管线完成 docId=${docId} 写入块数=${chunks.length}`);
  }
}
