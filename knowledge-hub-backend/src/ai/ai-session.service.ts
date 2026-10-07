import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import SnowflakeId from 'snowflake-id';
import { RedisService } from '../auth/redis.service';
import { KhAiSession } from './entities/ai-session.entity';
import { KhAiMessage } from './entities/ai-message.entity';
import { Mem0Service } from './mem0.service';
import { chatWindowKeys } from './memory-keys';

/** 会话视图（列表/详情返回 camelCase） */
export interface AiSessionView {
  id: string;
  title: string;
  updatedAt: string;
}

/** 引用来源 v2（工单 08 v2 协议）：index/kind/title/ref/url/excerpt */
export interface AiSourceV2 {
  index: number;
  /** 12 号工单：graph = 知识图谱关系三元组来源 */
  kind: 'knowledge' | 'web' | 'graph';
  title: string;
  ref?: string;
  url?: string;
  excerpt?: string;
  heading?: string | null;
}

/** 消息视图 */
export interface AiMessageView {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  sources: AiSourceV2[] | null;
  createdAt: string;
}

/** 历史窗口：注入 Agent 的最近轮数上限（10 轮 = 20 条） */
export const HISTORY_WINDOW = 20;

/**
 * AI 会话服务（二期工单 08）：会话 CRUD + 消息持久化 + 归属校验。
 * 表结构由 init.sql 管理（kh_ai_session / kh_ai_message），主键应用层雪花。
 */
@Injectable()
export class AiSessionService {
  private readonly snowflake = new SnowflakeId();

  constructor(
    @InjectRepository(KhAiSession)
    private readonly sessionRepo: Repository<KhAiSession>,
    @InjectRepository(KhAiMessage)
    private readonly messageRepo: Repository<KhAiMessage>,
    private readonly mem0: Mem0Service,
    private readonly redis: RedisService,
  ) { }

  /** 会话列表（按 updated_at DESC，对齐索引 idx_kh_ai_session_user_updated）；preview = 最新 assistant 回答前 30 字 */
  async listSessions(userId: string): Promise<{ list: AiSessionView[] }> {
    const rows = await this.sessionRepo.find({
      where: { user_id: userId },
      order: { updated_at: 'DESC' },
      take: 100,
    });
    const previews = new Map<string, string>();
    if (rows.length > 0) {
      const ids = rows.map((r) => r.id);
      const pv = (await this.messageRepo.query(
        `SELECT DISTINCT ON (session_id) session_id, content
         FROM kh_ai_message
         WHERE role = 'assistant' AND session_id = ANY($1::bigint[])
         ORDER BY session_id, created_at DESC`,
        [ids],
      )) as Array<{ session_id: string; content: string }>;
      for (const p of pv) previews.set(String(p.session_id), String(p.content ?? '').slice(0, 30));
    }
    return {
      list: rows.map((r) => ({
        id: r.id,
        title: r.title,
        preview: previews.get(r.id) ?? '',
        updatedAt: r.updated_at.toISOString(),
      })),
    };
  }

  /** 创建会话（title 默认取首问前 20 字） */
  async createSession(userId: string, title: string): Promise<AiSessionView> {
    const row = await this.sessionRepo.save(
      this.sessionRepo.create({
        id: this.snowflake.generate(),
        user_id: userId,
        title: title.slice(0, 80),
      }),
    );
    return { id: row.id, title: row.title, updatedAt: row.updated_at.toISOString() };
  }

  /** 校验归属并返回会话（非本人 403，防御跨用户读写） */
  private async assertOwned(sessionId: string, userId: string): Promise<KhAiSession> {
    const row = await this.sessionRepo.findOne({ where: { id: sessionId } });
    if (!row) throw new NotFoundException('会话不存在');
    if (row.user_id !== userId) throw new ForbiddenException('无权访问该会话');
    return row;
  }

  /** 会话消息（按 created_at ASC 全量） */
  async getMessages(sessionId: string, userId: string): Promise<{ session: AiSessionView; messages: AiMessageView[] }> {
    const session = await this.assertOwned(sessionId, userId);
    const rows = await this.messageRepo.find({
      where: { session_id: sessionId },
      order: { created_at: 'ASC' },
    });
    return {
      session: { id: session.id, title: session.title, updatedAt: session.updated_at.toISOString() },
      messages: rows.map((r) => ({
        id: r.id,
        role: r.role as 'user' | 'assistant',
        content: r.content,
        sources: (r.sources as AiMessageView['sources']) ?? null,
        createdAt: r.created_at.toISOString(),
      })),
    };
  }

  /** 追加消息（user / assistant 通用） */
  async appendMessage(
    sessionId: string,
    userId: string,
    role: 'user' | 'assistant',
    content: string,
    sources?: AiSourceV2[],
  ): Promise<void> {
    await this.assertOwned(sessionId, userId);
    await this.messageRepo.save(
      this.messageRepo.create({
        id: this.snowflake.generate(),
        session_id: sessionId,
        role,
        content,
        sources: sources ?? null,
      }),
    );
    // 刷新会话 updated_at（列表按最近活跃排序）
    await this.sessionRepo.update({ id: sessionId }, { updated_at: new Date() });
  }

  /** 自动建会话（不存在时）：返回既有的或新建的 id */
  async ensureSession(sessionId: string | undefined, userId: string, firstQuestion: string): Promise<string> {
    if (sessionId) {
      await this.assertOwned(sessionId, userId);
      return sessionId;
    }
    return (await this.createSession(userId, firstQuestion.slice(0, 20))).id;
  }

  /** 清空对话（删消息，保留会话壳） */
  async clearMessages(sessionId: string, userId: string): Promise<void> {
    await this.assertOwned(sessionId, userId);
    await this.messageRepo.delete({ session_id: sessionId });
    this.cleanupMemory(userId, sessionId);
  }

  /** 删除会话（消息经 FK CASCADE 级联删除） */
  async deleteSession(sessionId: string, userId: string): Promise<{ id: string }> {
    await this.assertOwned(sessionId, userId);
    await this.sessionRepo.delete({ id: sessionId });
    this.cleanupMemory(userId, sessionId);
    return { id: sessionId };
  }

  /** 记忆清理联动（工单 10 图2：异步仅清会话层记忆与短期缓存，用户层保留不变） */
  private cleanupMemory(userId: string, sessionId: string): void {
    void this.mem0.deleteAllByRun(userId, sessionId);
    const { messagesKey, summaryKey } = chatWindowKeys(userId, sessionId);
    void Promise.all([this.redis.del(messagesKey), this.redis.del(summaryKey)]).catch(() => undefined);
  }

  /** 历史窗口（最近 N 条，升序返回，注入 Agent 上下文） */
  async historyWindow(sessionId: string, limit = HISTORY_WINDOW): Promise<Array<{ role: string; content: string }>> {
    const rows = await this.messageRepo.find({
      where: { session_id: sessionId },
      order: { created_at: 'DESC' },
      take: limit,
    });
    return rows.reverse().map((r) => ({ role: r.role, content: r.content }));
  }
}
