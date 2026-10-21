#!/usr/bin/env node
/**
 * s11 · 预算拦截有效性（工单 24 指标 #11）
 *
 * 断言：
 *   硬约束  tool_calls ≤ 4            —— 预算上限不可被突破
 *   软断言  answer 非空且收束          —— 被拒后模型应基于已有信息作答，而不是继续尝试
 *   条件断言 tool_calls === 4           —— 只有真正触顶，才证明拦截分支被走到
 *
 * ⚠️ 一个必须说明的观测限制（工单原文假设「解析 tool 回执」，实际做不到）：
 * SSE 只下发**成功执行**的工具事件（data-retrieve / data-graph / data-web-search，
 * rewrite 走 data-status 的 stage）。被门控拒绝的 ToolMessage 不进事件流，
 * 所以客户端看到的 tool_calls 是「成功次数」，不是「尝试次数」。
 * 「第 5 次被拦」只能间接推断：tool_calls 恰好触到 4 且模型停止了调用。
 * 要直接观察拒绝，需把 22 号工单的 tool_denial 落进 SSE（尚未实现）。
 *
 * 用法：
 *   EVAL_PASSWORD=xxx node test/eval/suite/s11-budget.mjs
 *   SUITE_DIR=<dir> 复用已有 suite 目录（run-all 调用时传）
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  login,
  sseStream,
  summarizeTurn,
  preflight,
  TOOL_BUDGET_LIMITS,
} from '../lib/base.mjs';
import { createSuiteDir, writeItemJson } from '../lib/report.mjs';

/**
 * 压力用例：一句话塞 5 个子问题 + 1 个明确不存在的主题。
 * 目的是诱导模型多次调用 retrieve_knowledge（换词重检）与 rewrite_query。
 */
const PRESSURE_QUERIES = [
  '请分别回答以下五个问题，每个都要给出依据：1) 加班餐补每天上限多少 2) 差旅住宿报销标准 3) 年假天数怎么计算 4) 王工在立项流程里负责什么 5) 量子计算采购审批流程是什么',
];

const sec = (ms) => (ms / 1000).toFixed(1);

/**
 * 「仍在检索」的文本特征（工单原文要求：答案必须收束，非"继续检索"）。
 *
 * 为什么会这样：`answer` 是逐轮 text-delta 累积的。预算耗尽时模型连续几轮都在输出
 * 「正在检索…」「正在换词重检…」这类过程叙述，最后一轮又没等到真正的结论，
 * 于是用户看到的全文就是一堆「正在检索」—— 技术上非空，实际等于没答。
 */
const STILL_SEARCHING = /正在(检索|搜索|查询|换词|重新检索)|继续检索|稍后再|接下来我会/;

async function main() {
  const suiteDir = process.env.SUITE_DIR ?? createSuiteDir();
  const started = new Date();

  console.log('s11 · 预算拦截有效性');
  console.log('='.repeat(64));

  const token = await login();

  // 环境体检：路由降级时预算行为会失真（意图恒 knowledge → 工具集恒定）
  const issues = await preflight(token);
  if (issues.length) {
    console.log('❌ 环境体检未通过，终止：');
    for (const i of issues) console.log('   - ' + i);
    writeItemJson(suiteDir, 's11-budget', {
      status: 'skip',
      reason: 'preflight failed',
      issues,
    });
    process.exitCode = 2;
    return;
  }
  console.log('✅ 环境体检通过\n');

  const results = [];
  for (const [i, query] of PRESSURE_QUERIES.entries()) {
    console.log(`[${i + 1}/${PRESSURE_QUERIES.length}] 压力查询（${query.length} 字）`);
    const turn = await sseStream(token, { content: query });
    const f = summarizeTurn(turn.events, turn.wall_ms);

    const withinBudget = f.tool_calls <= TOOL_BUDGET_LIMITS.total;
    const touched = f.tool_calls >= TOOL_BUDGET_LIMITS.total;
    const stillSearching = STILL_SEARCHING.test(f.answer);
    const collapsed = !f.empty_answer && !stillSearching;

    console.log(`  intent=${f.intent}  轮数=${f.steps}  工具调用=${f.tool_calls}/${TOOL_BUDGET_LIMITS.total}`);
    console.log(`  分布: ${Object.entries(f.tools).map(([k, v]) => `${k}=${v}`).join(' ')}`);
    console.log(`  耗时=${sec(turn.wall_ms)}s  TTFT(事件)=${turn.ttft_event_ms}ms  TTFT(文本)=${turn.ttft_text_ms}ms`);
    console.log(`  答案 ${f.answer_len} 字：${f.answer.replace(/\s+/g, ' ').slice(0, 80)}`);
    console.log(`  ${withinBudget ? '✅' : '❌'} 未越界（≤${TOOL_BUDGET_LIMITS.total}）`);
    console.log(`  ${collapsed ? '✅ 答案收束' : stillSearching ? '❌ 未收束：答案仍停在「正在检索」的过程叙述' : '❌ 空答案'}`);
    console.log(`  ${touched ? '✅ 预算触顶，拦截分支被走到' : '⚠️ 本轮未触顶（tool_calls < 4），预算上限未被实际验证'}`);

    results.push({
      query,
      intent: f.intent,
      steps: f.steps,
      tool_calls: f.tool_calls,
      tools: f.tools,
      within_budget: withinBudget,
      budget_touched: touched,
      answer_len: f.answer_len,
      empty_answer: f.empty_answer,
      still_searching: stillSearching,
      answer_preview: f.answer.slice(0, 200),
      wall_ms: turn.wall_ms,
      ttft_event_ms: turn.ttft_event_ms,
      ttft_text_ms: turn.ttft_text_ms,
      errors: f.errors,
    });
    console.log('');
  }

  const allWithin = results.every((r) => r.within_budget);
  const allCollapsed = results.every((r) => !r.empty_answer && !r.still_searching);
  const anyTouched = results.some((r) => r.budget_touched);

  const status = allWithin && allCollapsed ? 'pass' : 'fail';
  const conclusion = !allWithin
    ? '工具调用数突破总预算上限'
    : results.some((r) => r.still_searching)
      ? '预算耗尽后答案未收束：全文停在「正在检索」的过程叙述，用户拿不到结论'
      : !allCollapsed
        ? '预算压力下出现空答案'
        : anyTouched
          ? '预算触顶且答案正确收束'
          : '未越界且未出空答案，但本轮未触顶 —— 拦截分支未被实际走到';

  const payload = {
    id: 's11',
    name: '预算拦截有效性',
    status,
    metric: `tool_calls 最大 ${Math.max(...results.map((r) => r.tool_calls))} / 上限 ${TOOL_BUDGET_LIMITS.total}`,
    target: '≤4 且答案非空',
    conclusion,
    budget_touched: anyTouched,
    observation_limit:
      'SSE 不下发被拒的 ToolMessage，tool_calls 是成功次数而非尝试次数；「第 5 次被拦」只能由「触顶 4 次后停止调用」间接推断',
    started_at: started.toISOString(),
    finished_at: new Date().toISOString(),
    results,
  };
  writeItemJson(suiteDir, 's11-budget', payload);

  console.log('='.repeat(64));
  console.log(`结论：${conclusion}`);
  console.log(`状态：${status === 'pass' ? '✅ 通过' : '❌ 失败'}`);
  if (!anyTouched) {
    console.log('提示：要让预算必然触顶，可临时把 TOOL_BUDGET_LIMITS.total 调低（需重编译重启），');
    console.log('      或在 22 号工单的 denyToolsNextRound 处补一条 SSE 事件后再测。');
  }
  console.log(`明细：${join(suiteDir, 's11-budget.json')}`);

  if (status !== 'pass') process.exitCode = 1;
}

main().catch((err) => {
  console.error('s11 执行失败:', err);
  process.exitCode = 1;
});
