import { buildToolDenial, TOOL_BUDGET_LIMITS } from './tool-denial';

/**
 * 结构化拒绝（工单 22 验收项 5）。
 *
 * 为什么这条必须单测：`reason` 决定模型下一步怎么走，而三种原因在代码里只差一个
 * if 分支的顺序。如果哪天有人调换 `allowed()` 的判断顺序却没同步这里，
 * 模型会在「预算已用尽」时被误导去「换个工具试试」，白烧一轮调用；
 * 或者反过来，在「本轮不该用」时以为「下次还能用」而反复重试。
 *
 * 顺带钉住 `budget_remaining` 不会出现负数（超预算时 `Math.max(0, ...)`）。
 */
describe('buildToolDenial', () => {
  const noBudget = { total: 0, rewrite: 0, web: 0, graph: 0 };
  const allTools = new Set([
    'retrieve_knowledge',
    'rewrite_query',
    'web_search',
    'retrieve_graph',
  ]);

  it('意图不允许 → intent_gate，并在建议里列出本轮可用工具', () => {
    const intentTools = new Set(['web_search']);
    const denial = buildToolDenial('retrieve_knowledge', intentTools, noBudget);

    expect(denial.reason).toBe('intent_gate');
    expect(denial.available).toBe(false);
    expect(denial.tool).toBe('retrieve_knowledge');
    expect(denial.remediation).toContain('web_search');
    expect(denial.remediation).toContain('本轮不涉及该能力');
  });

  it('总预算用尽 → budget_total（即便该工具本身还没用过）', () => {
    const denial = buildToolDenial('web_search', allTools, {
      total: TOOL_BUDGET_LIMITS.total,
      rewrite: 1,
      web: 0,
      graph: 1,
    });

    expect(denial.reason).toBe('budget_total');
    expect(denial.remediation).toContain('预算已用尽');
    expect(denial.budget_remaining.total).toBe(0);
  });

  it('单工具已用过 → budget_per_tool（总预算还有剩余）', () => {
    const denial = buildToolDenial('rewrite_query', allTools, {
      total: 1,
      rewrite: 1,
      web: 0,
      graph: 0,
    });

    expect(denial.reason).toBe('budget_per_tool');
    expect(denial.remediation).toContain('本轮已用过');
    // 剩余次数如实反映：总预算还剩 3，但 rewrite 已归零
    expect(denial.budget_remaining).toEqual({
      total: 3,
      rewrite: 0,
      web: 1,
      graph: 1,
    });
  });

  it('判断顺序：意图优先于预算（两者都不满足时归 intent_gate）', () => {
    const intentTools = new Set(['retrieve_knowledge']);
    const denial = buildToolDenial('web_search', intentTools, {
      total: TOOL_BUDGET_LIMITS.total,
      rewrite: 1,
      web: 1,
      graph: 1,
    });

    expect(denial.reason).toBe('intent_gate');
  });

  it('budget_remaining 不会为负（超预算时钳到 0）', () => {
    const denial = buildToolDenial('retrieve_knowledge', allTools, {
      total: 9,
      rewrite: 9,
      web: 9,
      graph: 9,
    });

    expect(denial.budget_remaining).toEqual({
      total: 0,
      rewrite: 0,
      web: 0,
      graph: 0,
    });
  });

  it('limits 可注入（测试与将来调整预算时不改函数体）', () => {
    const denial = buildToolDenial(
      'web_search',
      allTools,
      { total: 2, rewrite: 0, web: 0, graph: 0 },
      { total: 3, rewrite: 1, web: 2, graph: 1 },
    );

    expect(denial.reason).toBe('budget_per_tool');
    expect(denial.budget_remaining.web).toBe(2);
  });
});
