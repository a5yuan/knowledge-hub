import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import amqp, { ChannelWrapper, AmqpConnectionManager } from 'amqp-connection-manager';
import type { ConsumeMessage } from 'amqplib';

/** 发布事件交换机（direct）与两队列拓扑（Search 已迁移至 SEARCH_EXCHANGE） */
export const DOCUMENT_EXCHANGE = 'document.events';
export const QUEUE_RAG = 'rag.queue';
export const QUEUE_KG = 'kg.queue';
export const ROUTING_KEYS = ['rag', 'kg'] as const;
export type RoutingKey = (typeof ROUTING_KEYS)[number];

/** 全文检索交换机（topic）与快照索引队列拓扑（二期，见架构图《全文检索（Search）流程》） */
export const SEARCH_EXCHANGE = 'kh.document.exchange';
export const QUEUE_DOC_SEARCH = 'kh.document.search.queue';
export const ROUTING_KEY_DOC_INDEX = 'document.index';

/** 发布消息体：pipeline/后续消费者按 docId 查库取数据 */
export interface DocumentPublishPayload {
  docId: string;
  title: string;
  publishedAt: string;
  /** 09 号工单：可见性字段（kh_chunk 召回过滤用）；旧消息可能缺省，消费侧兜底（author/team 空、status=1、is_public=false） */
  authorId?: string | null;
  teamId?: string | null;
  status?: number;
  isPublic?: boolean;
}

/** 全文检索快照消息体：整篇元数据 + 正文（发布端构建，消费者直接索引不回查库） */
export interface DocumentIndexPayload {
  docId: string;
  title: string;
  summary: string | null;
  content: string;
  tags: string | null;
  authorId: string | null;
  categoryId: string | null;
  teamId: string | null;
  status: number;
  isPublic: boolean;
  wordCount: number;
  publishTime: string | null;
  publishedAt: string;
}

/** 队列消费者回调：抛错视为消费失败（错误日志 + ack 丢弃，不重投） */
export type ConsumeHandler = (payload: unknown) => Promise<void>;

/**
 * RabbitMQ 封装（对应架构图"2. mq 模块"）
 * Publish → Exchange(document.events) → Queue → Consume
 */
@Injectable()
export class MqService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(MqService.name);
  private connection?: AmqpConnectionManager;
  private channel?: ChannelWrapper;

  constructor(private readonly config: ConfigService) { }

  async onModuleInit(): Promise<void> {
    const url = this.config.get<string>('RABBITMQ_URL', 'amqp://guest:guest@localhost:5672');
    this.connection = amqp.connect([url]);
    this.connection.on('connectFailed', ({ err }) => {
      this.logger.error(`RabbitMQ 连接失败，将自动重试: ${err.message}`);
    });

    this.channel = this.connection.createChannel({
      json: true,
      setup: async (ch) => {
        await ch.assertExchange(DOCUMENT_EXCHANGE, 'direct', { durable: true });
        // RAG 消费者：pipeline 模块监听（一期实现）
        await ch.assertQueue(QUEUE_RAG, { durable: true });
        await ch.bindQueue(QUEUE_RAG, DOCUMENT_EXCHANGE, 'rag');
        // KG 消费者：kg 模块监听（实体关系抽取写 Neo4j）
        await ch.assertQueue(QUEUE_KG, { durable: true });
        await ch.bindQueue(QUEUE_KG, DOCUMENT_EXCHANGE, 'kg');

        // 全文检索（二期）：topic 交换机，routing key document.index → kh.document.search.queue
        await ch.assertExchange(SEARCH_EXCHANGE, 'topic', { durable: true });
        await ch.assertQueue(QUEUE_DOC_SEARCH, { durable: true });
        await ch.bindQueue(QUEUE_DOC_SEARCH, SEARCH_EXCHANGE, ROUTING_KEY_DOC_INDEX);
      },
    });
    this.logger.log(
      `RabbitMQ 拓扑初始化完成 exchange=${DOCUMENT_EXCHANGE} queues=${ROUTING_KEYS.join('/')} ` +
      `+ exchange=${SEARCH_EXCHANGE}(topic) queue=${QUEUE_DOC_SEARCH}`,
    );
  }

  /** 发布：投递到交换机（json 通道自动 JSON 编码，ConfirmChannel 等待 broker 确认） */
  async publish(
    routingKey: string,
    payload: DocumentPublishPayload | DocumentIndexPayload,
  ): Promise<void> {
    if (!this.channel) {
      throw new Error('RabbitMQ 通道未初始化');
    }
    const exchange = routingKey === ROUTING_KEY_DOC_INDEX ? SEARCH_EXCHANGE : DOCUMENT_EXCHANGE;
    await this.channel.publish(exchange, routingKey, payload, { persistent: true });
    this.logger.log(`消息已投递 exchange=${exchange} routingKey=${routingKey} docId=${payload.docId}`);
  }

  /** 消费：监听队列，prefetch=1 手动 ack；失败仅记日志后 ack 丢弃，避免毒消息阻塞队列（TODO 二期 DLQ） */
  async consume(queue: string, handler: ConsumeHandler): Promise<void> {
    if (!this.channel) {
      throw new Error('RabbitMQ 通道未初始化');
    }
    await this.channel.consume(
      queue,
      async (msg: ConsumeMessage | null) => {
        if (!msg) return;
        let payload: unknown;
        try {
          payload = JSON.parse(msg.content.toString('utf8'));
        } catch (err) {
          this.logger.error(`消息 JSON 解析失败 queue=${queue}: ${(err as Error).message}`);
          this.channel?.ack(msg);
          return;
        }
        const docId = (payload as DocumentPublishPayload)?.docId ?? '-';
        try {
          await handler(payload);
          this.channel?.ack(msg);
          this.logger.log(`消息消费完成 queue=${queue} docId=${docId}`);
        } catch (err) {
          this.logger.error(`消费失败 queue=${queue} docId=${docId}: ${(err as Error).message}`);
          this.channel?.ack(msg);
        }
      },
      { prefetch: 1 },
    );
    this.logger.log(`消费者已注册 queue=${queue}`);
  }

  async onModuleDestroy(): Promise<void> {
    await this.channel?.close().catch(() => undefined);
    await this.connection?.close().catch(() => undefined);
  }
}
