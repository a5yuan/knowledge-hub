import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ChatOpenAI } from '@langchain/openai';
import { HumanMessage } from '@langchain/core/messages';
import { RedisService } from '../auth/redis.service';
import { AiSessionService, HISTORY_WINDOW } from './ai-session.service';
import { CachedMessage, chatWindowKeys } from './memory-keys';
import { TracingService } from '../observability/tracing.service';

/** 短期记忆 TTL（图1：24 小时，每轮写入刷新） */
const TTL_SECONDS = 24 * 3600;

/**
 * Redis 短期记忆服务（工单 10，图1 滑动窗口机制）：
 * - 读：Redis 命中直接返回；miss（TTL 过期/首次）→ PG 回填最近 N 条重建窗口（TTL 重置 24h）
 * - 写：每轮问答后 writeBack 回写并刷新 TTL；挤出窗口的旧消息交给增量摘要
 * - 摘要：溢出历史 LLM 增量摘要（异步不阻塞），随上下文注入（图1 底部）
 * - Redis 不可用全链路静默降级 PG 直读（即 08 工单现状路径），不中断对话
 */
@Injectable()
export class MemoryCacheService {
  private readonly logger = new Logger(MemoryCacheService.name);

  constructor(
    private readonly redis: RedisService,
    private readonly sessions: AiSessionService,
    private readonly config: ConfigService,
    private readonly tracing: TracingService,
  ) {}

  /** 读窗口（图3 第1步）：返回滑动窗口消息 + 摘要（无则空） */
  async loadWindow(
    userId: string,
    sessionId: string,
  ): Promise<{ messages: CachedMessage[]; summary: string }> {
    const { messagesKey, summaryKey } = chatWindowKeys(userId, sessionId);
    try {
      const [raw, summary] = await Promise.all([
        this.redis.get(messagesKey),
        this.redis.get(summaryKey),
      ]);
      if (raw) {
        const arr = JSON.parse(raw) as unknown;
        if (Array.isArray(arr)) {
          return {
            messages: arr.filter(
              (m): m is CachedMessage =>
                !!m &&
                typeof m === 'object' &&
                typeof (m as CachedMessage).content === 'string',
            ),
            summary: summary ?? '',
          };
        }
      }
      // miss → 从 PostgreSQL 回填最近 N 条重建滑动窗口（图1「TTL 过期怎么办」）
      const messages = await this.sessions.historyWindow(sessionId);
      await this.redis.setex(
        messagesKey,
        TTL_SECONDS,
        JSON.stringify(messages),
      );
      return { messages, summary: summary ?? '' };
    } catch (err) {
      this.logger.warn(
        `短期记忆读降级(PG 直读): ${err instanceof Error ? err.message : err}`,
      );
      return {
        messages: await this.sessions.historyWindow(sessionId).catch(() => []),
        summary: '',
      };
    }
  }

  /** 写回一条消息并刷新 TTL（图3 第5步回写）；返回被挤出窗口的旧消息（供增量摘要） */
  async writeBack(
    userId: string,
    sessionId: string,
    entry: CachedMessage,
  ): Promise<CachedMessage[]> {
    const { messagesKey } = chatWindowKeys(userId, sessionId);
    try {
      const raw = await this.redis.get(messagesKey);
      let arr: CachedMessage[] | null = raw
        ? (JSON.parse(raw) as CachedMessage[])
        : null;
      if (!Array.isArray(arr))
        arr = await this.sessions.historyWindow(sessionId);
      arr.push(entry);
      const evicted =
        arr.length > HISTORY_WINDOW
          ? arr.slice(0, arr.length - HISTORY_WINDOW)
          : [];
      await this.redis.setex(
        messagesKey,
        TTL_SECONDS,
        JSON.stringify(arr.slice(-HISTORY_WINDOW)),
      );
      return evicted;
    } catch (err) {
      this.logger.warn(
        `短期记忆写回降级: ${err instanceof Error ? err.message : err}`,
      );
      return [];
    }
  }

  /** 溢出历史增量摘要（图1 底部；异步不阻塞，失败静默——下轮溢出自然重试） */
  async summarizeOverflow(
    userId: string,
    sessionId: string,
    evicted: CachedMessage[],
  ): Promise<void> {
    if (evicted.length === 0) return;
    const { summaryKey } = chatWindowKeys(userId, sessionId);
    try {
      const old = (await this.redis.get(summaryKey)) ?? '';
      const model = new ChatOpenAI({
        openAIApiKey: this.config.get<string>('OPENAI_API_KEY'),
        modelName: this.config.get<string>('MEMORY_LLM_MODEL', 'qwen-turbo'),
        temperature: 0.1,
        maxTokens: 400,
        maxRetries: 0,
        configuration: {
          baseURL: this.config.get<string>('EMBEDDING_BASE_URL'),
          timeout: 10000,
        },
        // 工单 13：溢出摘要为异步任务，调用发生在对话 trace 上下文内，观察自动挂到该 trace
        callbacks: this.tracing.current(),
      } as never);
      const resp = await model.invoke([
        new HumanMessage(
          `请把下面这些较早的对话历史合并为一份简明摘要${old ? '（先把已有摘要与新内容合并）' : ''}。
要求：简体中文要点式，保留任务、进度、结论、用户偏好等关键信息，300 字以内。直接输出摘要文本本身，不要输出任何解释或对任务本身的描述。
${old ? `\n【已有摘要】\n${old}\n` : ''}
【较早期对话消息】
${evicted
  .map(
    (m) => `${m.role === 'user' ? '用户' : '助手'}：${m.content.slice(0, 300)}`,
  )
  .join('\n')}`,
        ),
      ]);
      const text = typeof resp.content === 'string' ? resp.content.trim() : '';
      if (text) await this.redis.setex(summaryKey, TTL_SECONDS, text);
    } catch (err) {
      this.logger.warn(
        `短期记忆摘要降级: ${err instanceof Error ? err.message : err}`,
      );
    }
  }

  /** 清空对话/删除会话时同步清理短期缓存（避免脏窗口） */
  async clearSession(userId: string, sessionId: string): Promise<void> {
    const { messagesKey, summaryKey } = chatWindowKeys(userId, sessionId);
    try {
      await Promise.all([
        this.redis.del(messagesKey),
        this.redis.del(summaryKey),
      ]);
    } catch (err) {
      this.logger.warn(
        `短期记忆清理降级: ${err instanceof Error ? err.message : err}`,
      );
    }
  }
}
