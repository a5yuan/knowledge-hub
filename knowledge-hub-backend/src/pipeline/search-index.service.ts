import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import {
  DocumentIndexPayload,
  MqService,
  QUEUE_DOC_SEARCH,
} from '../mq/mq.service';
import { DocIndexService } from '../es/doc-index.service';

/**
 * Search 消费者（对应架构图"Search 消费者 监听 kh.document.search.queue"）
 * 处理 INDEX 消息（整篇元数据 + 正文）→ 创建/更新 ES 文档索引 kh_document
 * 消息体已含整篇快照，无需回查数据库（与 RAG 消费者查库模式不同）
 */
@Injectable()
export class SearchIndexService implements OnModuleInit {
  private readonly logger = new Logger(SearchIndexService.name);

  constructor(
    private readonly mq: MqService,
    private readonly docIndex: DocIndexService,
  ) { }

  /** 监听 kh.document.search.queue（mq 模块负责重连与 ack） */
  onModuleInit(): void {
    void this.mq.consume(QUEUE_DOC_SEARCH, async (payload) => {
      await this.process(payload as DocumentIndexPayload);
    });
  }

  /** 单条快照消息的索引流程，任一步抛错由 mq 模块记日志并 ack */
  private async process(payload: DocumentIndexPayload): Promise<void> {
    const docId = payload?.docId;
    if (!docId) {
      this.logger.warn('search 快照消息缺少 docId，跳过');
      return;
    }
    await this.docIndex.indexDocument(payload);
    this.logger.log(`Search 管线完成 docId=${docId} title=${payload.title ?? ''}`);
  }
}
