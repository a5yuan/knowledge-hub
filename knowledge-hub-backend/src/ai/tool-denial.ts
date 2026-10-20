/**
 * 工具不可用的结构化拒绝（工单 22 步骤 3）。
 *
 * 抽成独立模块的原因：工单 22 的验收项 5 要求**单测断言 `tool_denial.reason`**。
 * 埋在 `ai-agent.service.ts` 里就只能靠 Langfuse 抓请求体，而那是事后观察、不是回归保护。
 *
 * 拒绝原因的语义差别是这条链路的关键：
 * - `intent_gate`：本轮意图压根不允许用这个工具 → 模型应当换路
 * - `budget_total`：本轮工具总次数用尽 → 模型应当停止调工具、立刻作答
 * - `budget_per_tool`：这个工具本轮已用过 → 模型可以改用别的工具
 *
 * 把三种情况混成一句「意图门控或预算」，三种启发一条都传达不到。
 */

/** 单轮预算上限（11/12 号工单口径：总 4 次，rewrite / web / graph 各 1 次） */
export const TOOL_BUDGET_LIMITS = {
  total: 4,
  rewrite: 1,
  web: 1,
  graph: 1,
} as const;

/** 拒绝原因三态，与 `allowed()` 的判断顺序严格对应（意图 → 总预算 → 单工具预算） */
export type ToolDenialReason =
  'intent_gate' | 'budget_total' | 'budget_per_tool';

/** 结构化拒绝载荷（挂 `ToolMessage.additional_kwargs.tool_denial`） */
export interface ToolDenial {
  tool: string;
  available: false;
  reason: ToolDenialReason;
  /** 各类剩余次数（用于评测统计与 trace 分析） */
  budget_remaining: {
    total: number;
    rewrite: number;
    web: number;
    graph: number;
  };
  /** 给模型的行动建议（同时拼进 ToolMessage.content） */
  remediation: string;
}

/** 已消耗的预算计数（与编排循环里的 `budget` 同形） */
export interface BudgetUsage {
  total: number;
  rewrite: number;
  web: number;
  graph: number;
}

/**
 * 构造结构化拒绝。
 *
 * @param name            被拒的工具名
 * @param intentToolNames 本轮意图允许的工具名集合
 * @param budget          已消耗计数
 * @param limits          预算上限（默认 `TOOL_BUDGET_LIMITS`，测试可注入）
 */
export function buildToolDenial(
  name: string,
  intentToolNames: Set<string>,
  budget: BudgetUsage,
  limits: BudgetUsage = TOOL_BUDGET_LIMITS,
): ToolDenial {
  const reason: ToolDenialReason = !intentToolNames.has(name)
    ? 'intent_gate'
    : budget.total >= limits.total
      ? 'budget_total'
      : 'budget_per_tool';

  const budget_remaining = {
    total: Math.max(0, limits.total - budget.total),
    rewrite: Math.max(0, limits.rewrite - budget.rewrite),
    web: Math.max(0, limits.web - budget.web),
    graph: Math.max(0, limits.graph - budget.graph),
  };

  const remediation =
    reason === 'intent_gate'
      ? `本轮不涉及该能力，可用的工具：${[...intentToolNames].join(' / ') || '无'}；请改用可用工具，或直接基于已有资料作答`
      : reason === 'budget_total'
        ? `本轮工具调用预算已用尽（上限 ${limits.total} 次），请立即基于已有资料作答`
        : `「${name}」本轮已用过，请改用其它工具，或基于已有资料作答`;

  return {
    tool: name,
    available: false,
    reason,
    budget_remaining,
    remediation,
  };
}
