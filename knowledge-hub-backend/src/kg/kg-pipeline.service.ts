import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import {
  DocumentContent,
  DocumentContentDocument,
} from '../document/schemas/document-content.schema';
import { DocumentPublishPayload, MqService, QUEUE_KG } from '../mq/mq.service';
import { chunkMarkdown } from '../pipeline/chunker';
import { ExtractionService } from './extraction.service';
import type { Extraction } from './extraction.service';
import { KgService } from './kg.service';

/**
 * KG 管线消费者（对应架构图"KG 管道（知识图谱）"：监听 RabbitMQ kg 队列）
 * 文档快照 → 分块 → 抽取实体/关系 → 构建图谱 → 存入 Neo4j
 */
@Injectable()
export class KgPipelineService implements OnModuleInit {
  private readonly logger = new Logger(KgPipelineService.name);

  constructor(
    @InjectModel(DocumentContent.name)
    private readonly contentModel: Model<DocumentContentDocument>,
    private readonly mq: MqService,
    private readonly kg: KgService,
    private readonly extraction: ExtractionService,
    private readonly config: ConfigService,
  ) { }

  /** 监听 kg 队列（mq 模块负责重连与 ack） */
  onModuleInit(): void {
    void this.mq.consume(QUEUE_KG, async (payload) => {
      await this.process(payload as DocumentPublishPayload);
    });
  }

  /** 单条发布消息的完整管线，任一步抛错由 mq 模块记日志并 ack */
  private async process(payload: DocumentPublishPayload): Promise<void> {
    const docId = payload?.docId;
    if (!docId) {
      this.logger.warn('kg 消息缺少 docId，跳过');
      return;
    }

    // 1. 文档快照：查 Mongo 正文
    const content = await this.contentModel.findOne({ documentId: docId, deleted: false });
    if (!content || content.parse_state !== 'success' || !content.content) {
      this.logger.log(
        `文档不可构建图谱，跳过 docId=${docId} parse_state=${content?.parse_state ?? 'not_found'}`,
      );
      return;
    }

    // 2. 分块（复用 RAG chunkMarkdown，与向量块一一对应）
    const maxChars = Number(this.config.get<number>('RAG_CHUNK_MAX_CHARS', 500));
    const chunks = await chunkMarkdown(content.content, maxChars);
    if (!chunks.length) {
      this.logger.log(`正文分块为空，跳过 docId=${docId}`);
      return;
    }
    this.logger.log(`KG 分块完成 docId=${docId} 块数=${chunks.length} maxChars=${maxChars}`);

    // 3. 逐块抽取实体与关系（串行，prefetch=1 天然限流）
    const extractions: Extraction[] = [];
    for (const chunk of chunks) {
      extractions.push(await this.extraction.extract(chunk.content));
    }
    this.logger.log(`KG 实体关系抽取完成 docId=${docId} 块数=${chunks.length}`);

    // 4. 构建图谱并写入 Neo4j（先删后写幂等）
    await this.kg.rebuildGraph({ docId, title: payload.title ?? '', chunks, extractions });
    this.logger.log(`KG 管线完成 docId=${docId}`);
  }
}
