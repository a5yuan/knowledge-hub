/** 短期记忆缓存的消息形状 */
export interface CachedMessage {
  role: string;
  content: string;
}

/**
 * Redis key（工单 10 图1）：kh:chat:{userId}:{sessionId}:messages|summary
 * 独立成文件避免 ai-session ↔ memory-cache 循环导入（Nest DI undefined dependency）
 */
export function chatWindowKeys(userId: string, sessionId: string): { messagesKey: string; summaryKey: string } {
  return {
    messagesKey: `kh:chat:${userId}:${sessionId}:messages`,
    summaryKey: `kh:chat:${userId}:${sessionId}:summary`,
  };
}
