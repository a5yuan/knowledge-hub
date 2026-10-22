/**
 * 「预检索为空时代调检索」的判定（工单 24 P0）。
 *
 * 抽成纯函数是为了能单测边界 —— 这段判定决定了「要不要多花一次检索」，
 * 判错的两个方向都有代价：该触发不触发 = 模型继续凭记忆答；不该触发却触发 = 白花一次检索 + 预算。
 */

export interface ForceRetrieveInput {
  /** 该意图是否允许查知识库（chitchat / preference 为 false） */
  intentAllowsKb: boolean;
  /** 意图路由给出的 needRetrieve */
  needRetrieve: boolean;
  /** 闲聊标记（与 needRetrieve 并列判断，防路由自相矛盾时误触发） */
  isChitchat: boolean;
  /** 前置预检索命中的条数；0 表示空 */
  kbItemCount: number;
  /** 开关（FORCE_RETRIEVE_ON_EMPTY !== 'false'） */
  enabled: boolean;
}

export function shouldForceRetrieve(p: ForceRetrieveInput): boolean {
  if (!p.enabled) return false;
  if (!p.intentAllowsKb) return false;
  if (p.isChitchat) return false;
  if (!p.needRetrieve) return false;
  return p.kbItemCount === 0;
}
