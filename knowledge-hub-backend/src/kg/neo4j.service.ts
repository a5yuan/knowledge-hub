import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import neo4j from 'neo4j-driver';
import type { Driver } from 'neo4j-driver';

/** 递归归一化：驱动返回的 Integer（带 toNumber）转为普通 number，其余按结构拷贝 */
function toPlain(value: unknown): unknown {
  if (value && typeof value === 'object' && typeof (value as { toNumber?: unknown }).toNumber === 'function') {
    return (value as { toNumber(): number }).toNumber();
  }
  if (Array.isArray(value)) return value.map((v) => toPlain(v));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = toPlain(v);
    return out;
  }
  return value;
}

/**
 * Neo4j 驱动封装（对齐 EsService"纯客户端"分层）
 * 只负责连接生命周期与 Cypher 执行，图模型逻辑在 KgService
 */
@Injectable()
export class Neo4jService implements OnModuleDestroy {
  private readonly logger = new Logger(Neo4jService.name);
  private driver?: Driver;

  constructor(private readonly config: ConfigService) { }

  /** 懒初始化驱动（首次调用时读取配置） */
  private getDriver(): Driver {
    if (this.driver) return this.driver;
    const uri = this.config.get<string>('NEO4J_URI');
    const user = this.config.get<string>('NEO4J_USER');
    const password = this.config.get<string>('NEO4J_PASSWORD');
    if (!uri || !user || !password) {
      throw new Error('Neo4j 配置缺失，需设置 NEO4J_URI / NEO4J_USER / NEO4J_PASSWORD');
    }
    this.driver = neo4j.driver(uri, neo4j.auth.basic(user, password));
    this.logger.log(`Neo4j 驱动已初始化 uri=${uri}`);
    return this.driver;
  }

  /** 托管写事务执行 Cypher（瞬态错误自动重试），返回记录对象数组（Integer 已归一化为 number） */
  async run(cypher: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>[]> {
    const session = this.getDriver().session({ defaultAccessMode: neo4j.session.WRITE });
    try {
      return await session.executeWrite(async (tx) => {
        const result = await tx.run(cypher, params);
        return result.records.map((r) => toPlain(r.toObject()) as Record<string, unknown>);
      });
    } finally {
      await session.close();
    }
  }

  /** 只读事务执行 Cypher（查询 API 用，不触发写锁），返回记录对象数组（Integer 已归一化为 number） */
  async runRead(cypher: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>[]> {
    const session = this.getDriver().session({ defaultAccessMode: neo4j.session.READ });
    try {
      return await session.executeRead(async (tx) => {
        const result = await tx.run(cypher, params);
        return result.records.map((r) => toPlain(r.toObject()) as Record<string, unknown>);
      });
    } finally {
      await session.close();
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.driver?.close().catch(() => undefined);
  }
}
