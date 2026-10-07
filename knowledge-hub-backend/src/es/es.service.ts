import { Injectable, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Client } from '@elastic/elasticsearch';

/**
 * ES 客户端封装：仅负责连接管理
 * kh_chunk 向量索引的创建与写入见同目录 vector-index.service.ts
 */
@Injectable()
export class EsService implements OnModuleInit {
  private client!: Client;

  constructor(private readonly config: ConfigService) { }

  async onModuleInit(): Promise<void> {
    const node = this.config.get<string>('ES_NODE', 'http://localhost:9200');
    this.client = new Client({ node });
  }

  getClient(): Client {
    return this.client;
  }
}
