import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';

/**
 * Redis 客户端包装（对齐 neo4j.service.ts 风格）
 * 用途：邮箱激活 token（24h）/ 密码重置验证码（10 分钟）
 * 连接失败不阻断应用启动（仅记日志，与 Neo4j/ES 懒初始化策略一致），调用时抛错由上层处理
 */
@Injectable()
export class RedisService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RedisService.name);
  private client!: Redis;

  constructor(private readonly config: ConfigService) {}

  onModuleInit(): void {
    this.client = new Redis({
      host: this.config.get('REDIS_HOST', 'localhost'),
      port: Number(this.config.get('REDIS_PORT', 6379)),
      password: this.config.get('REDIS_PASSWORD') || undefined,
      db: Number(this.config.get('REDIS_DB', 0)),
      // 单命令快速失败，避免 Redis 宕机时请求长时间挂起
      maxRetriesPerRequest: 1,
    });
    this.client.on('error', (err) => this.logger.error(`Redis 连接错误: ${err.message}`));
    this.client.on('connect', () => this.logger.log('Redis 已连接'));
  }

  onModuleDestroy(): void {
    void this.client?.quit();
  }

  async get(key: string): Promise<string | null> {
    return this.client.get(key);
  }

  async setex(key: string, seconds: number, value: string): Promise<void> {
    await this.client.setex(key, seconds, value);
  }

  async del(key: string): Promise<void> {
    await this.client.del(key);
  }
}
