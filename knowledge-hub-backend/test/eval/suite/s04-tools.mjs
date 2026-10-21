#!/usr/bin/env node
/**
 * s04 · 工具选择准确率（工单 24 指标 #4）
 *
 * 和 s03 共用同一批请求：读 `s03-samples.json`，不重复打接口
 * （50 条 × 11 秒 ≈ 9 分钟，重跑一遍纯属浪费额度）。
 *
 * ## 三个口径
 * - **漏调率**：`must_call` 里列了却没被调用 → 该调不调，用户拿到无依据的回答
 * - **多余调用**：调用了不在 `must_call` 里的工具 → 白花预算，且常常伴随跑偏
 * - **工具级 P/R**：按工具聚合，能看出是「哪个工具在乱调」
 *
 * ⚠️ 22 号工单之后工具是**常驻**的（按意图裁剪已取消，改为调用时拒绝），
 * 所以口径从「下发了哪些工具」改成「实际调用了哪些工具」——
 * 再看「下发集合」已经没有意义（永远是 4 个）。
 *
 * 用法：
 *   EVAL_PASSWORD=xxx node test/eval/suite/s04-tools.mjs
 *   （需先跑 s03 产出 samples；缺失时本脚本会提示）
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createSuiteDir, writeItemJson, writeItemLog } from '../lib/report.mjs';

const MISS_TARGET = 0.15; // 漏调率上限
const EXTRA_TARGET = 1; // 单条多余调用上限

/** 全部工具名（与 src/ai/ai-agent.service.ts 的 allTools 一致） */
const ALL_TOOLS = ['retrieve_knowledge', 'retrieve_graph', 'rewrite_query', 'web_search'];

function main() {
  const suiteDir = process.env.SUITE_DIR ?? createSuiteDir();
  const samplesPath = join(suiteDir, 's03-samples.json');

  console.log('s04 · 工具选择准确率');
  console.log('='.repeat(70));

  if (!existsSync(samplesPath)) {
    console.log(`  ❌ 缺少 ${samplesPath} —— 先跑 s03（s04 复用它的请求结果，不重复打接口）`);
    writeItemJson(suiteDir, 's04-tools', {
      id: 's04',
      name: '工具选择准确率',
      status: 'skip',
      metric: '—',
      target: `漏调率 ≤${MISS_TARGET}；多余调用 ≤${EXTRA_TARGET} 次/条`,
      conclusion: '缺少 s03-samples.json，未执行',
    });
    process.exitCode = 2;
    return;
  }

  const { samples } = JSON.parse(readFileSync(samplesPath, 'utf8'));

  let mustTotal = 0;
  let missed = 0;
  let extraRows = 0;
  let maxExtra = 0;
  const rows = [];
  const logLines = [];

  for (const s of samples) {
    const must = s.expected_must_call ?? [];
    const called = ALL_TOOLS.filter((t) => (s.tools?.[t] ?? 0) > 0);
    const missedTools = must.filter((t) => !called.includes(t));
    const extraTools = called.filter((t) => !must.includes(t));

    mustTotal += must.length;
    missed += missedTools.length;
    if (extraTools.length > 0) extraRows += 1;
    maxExtra = Math.max(maxExtra, extraTools.length);

    rows.push({
      id: s.id,
      question: s.question,
      expected_intent: s.expected_intent,
      must_call: must,
      called,
      missed: missedTools,
      extra: extraTools,
      tool_calls: s.tool_calls,
    });

    if (missedTools.length || extraTools.length) {
      logLines.push(
        `- [${s.id}] ${s.question}\n  应调 ${JSON.stringify(must)}；实际 ${JSON.stringify(called)}` +
          `${missedTools.length ? `；漏调 ${JSON.stringify(missedTools)}` : ''}` +
          `${extraTools.length ? `；多余 ${JSON.stringify(extraTools)}` : ''}`,
      );
    }
  }

  // ── 工具级 P/R ──────────────────────────────────────────────
  const perTool = ALL_TOOLS.map((t) => {
    const expectedRows = samples.filter((s) => (s.expected_must_call ?? []).includes(t));
    const calledRows = samples.filter((s) => (s.tools?.[t] ?? 0) > 0);
    const tp = calledRows.filter((s) => (s.expected_must_call ?? []).includes(t)).length;
    const precision = calledRows.length ? tp / calledRows.length : null;
    const recall = expectedRows.length ? tp / expectedRows.length : null;
    return {
      tool: t,
      expected: expectedRows.length,
      called: calledRows.length,
      precision: precision === null ? null : Math.round(precision * 1000) / 1000,
      recall: recall === null ? null : Math.round(recall * 1000) / 1000,
      /** 期望调用该工具的条目，实际一次都没调的条数 */
      missed: expectedRows.length - tp,
    };
  });

  const missRate = mustTotal ? missed / mustTotal : 0;
  const extraPerRow = samples.length ? extraRows / samples.length : 0;
  const passed = missRate <= MISS_TARGET && maxExtra <= EXTRA_TARGET;
  const status = passed ? 'pass' : 'fail';

  console.log('-'.repeat(70));
  console.log(
    `漏调率 ${(missRate * 100).toFixed(1)}%（${missed}/${mustTotal}，上限 ${MISS_TARGET * 100}%）`,
  );
  console.log(
    `有多余调用的条目 ${extraRows}/${samples.length}（${(extraPerRow * 100).toFixed(1)}%），单条最多多调 ${maxExtra} 个`,
  );
  console.log('工具          期望  实际   precision  recall  漏调');
  for (const t of perTool) {
    console.log(
      `${t.tool.padEnd(20)}${String(t.expected).padStart(3)}  ${String(t.called).padStart(4)}` +
        `   ${String(t.precision ?? '—').padStart(6)} ${String(t.recall ?? '—').padStart(7)}` +
        `  ${t.missed}`,
    );
  }

  const payload = {
    id: 's04',
    name: '工具选择准确率',
    status,
    metric: `漏调率 ${(missRate * 100).toFixed(1)}%，多余调用最多 ${maxExtra} 个/条`,
    target: `漏调率 ≤${MISS_TARGET * 100}%；多余调用 ≤${EXTRA_TARGET} 次/条`,
    conclusion: passed
      ? `漏调率 ${(missRate * 100).toFixed(1)}%（${missed}/${mustTotal}），${extraRows} 条有多余调用，工具选择与标注基本一致`
      : `未达标：漏调率 ${(missRate * 100).toFixed(1)}%，单条最多多调 ${maxExtra} 个`,
    sample_size: samples.length,
    miss_rate: Math.round(missRate * 1000) / 1000,
    missed_calls: missed,
    must_call_total: mustTotal,
    extra_rows: extraRows,
    max_extra_per_row: maxExtra,
    per_tool: perTool,
    rows,
    caveats: [
      '22 号工单后工具常驻，口径是「实际调用了哪些」而非「下发了哪些」——下发集合恒为 4 个，不再有区分度',
      '多余调用不一定是错：knowledge_then_web 里调 web_search 是允许的，所以 web_search 的 precision 会偏低（分母含合法的补查）',
      'must_call 来自 intent-set.json 的标注，标签未人工确认时该指标同样是自一致性基线',
      's04 不单独发请求，直接复用 s03 的样本，sample_size 与 s03 相同',
    ],
  };

  writeItemJson(suiteDir, 's04-tools', payload);
  writeItemLog(suiteDir, 's04-tools', logLines.join('\n\n') || '（无漏调/多余调用）');

  console.log('='.repeat(70));
  console.log(`结论：${payload.conclusion}`);
  if (status !== 'pass') process.exitCode = 1;
}

main();
