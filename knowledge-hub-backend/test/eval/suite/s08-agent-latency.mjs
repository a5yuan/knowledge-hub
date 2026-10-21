#!/usr/bin/env node
/**
 * s08 · Agent 全链路延迟分位（工单 24 指标 #8）
 *
 * **不自己发请求**，复用 `s07-ttft.mjs` 写下的 `samples.json`。
 * 工单明确要求「与 s07 共用同一批次，不额外发请求」——同一次对话既能算 TTFT 也能算总耗时，
 * 分两次跑会让两条曲线的样本来源不同，失去可比性。
 *
 * 与 s06 的区别：
 * - s06 测的是**检索接口**（`GET /rag/search`）的延迟，不含 LLM 生成
 * - s08 测的是**整轮 Agent 对话**（意图路由 + 检索 + 工具循环 + 生成 + 推荐追问），
 *   是用户真正等的时间。两者不能互相替代。
 *
 * 按 intent 分组是必须的：闲聊零工具，knowledge 要检索+切题评估+可能多轮工具，
 * 全样本混在一起算分位会把两者抹平，看不出真实的耗时构成。
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { summarize } from '../lib/stats.mjs';
import { createSuiteDir, writeItemJson } from '../lib/report.mjs';

function main() {
  const suiteDir = process.env.SUITE_DIR ?? createSuiteDir();
  console.log('s08 · Agent 全链路延迟（复用 s07 样本）');

  const samplesPath = join(suiteDir, 'samples.json');
  if (!existsSync(samplesPath)) {
    console.log('  ❌ 缺少 samples.json，需先跑 s07-ttft.mjs');
    writeItemJson(suiteDir, 's08-agent-latency', {
      status: 'skip',
      reason: 'samples.json 不存在（依赖 s07 先执行）',
    });
    process.exitCode = 2;
    return;
  }

  const samples = JSON.parse(readFileSync(samplesPath, 'utf8'));
  const ok = samples.filter((s) => !s.error && Number.isFinite(s.wall_ms));
  if (!ok.length) {
    writeItemJson(suiteDir, 's08-agent-latency', {
      status: 'skip',
      reason: '样本中无有效 wall_ms',
    });
    process.exitCode = 2;
    return;
  }

  const all = summarize(ok.map((s) => s.wall_ms));

  // 按意图分组（用实际判定的 intent，不是数据集标注的——标注错时以实际路径为准）
  const groups = {};
  for (const s of ok) {
    const k = s.actual_intent ?? s.intent ?? 'unknown';
    (groups[k] ??= []).push(s.wall_ms);
  }
  const byIntent = Object.fromEntries(
    Object.entries(groups).map(([k, v]) => [k, summarize(v)]),
  );

  // 耗时与工具调用数的相关性（工具越多越慢，用于解释长尾）
  const withTools = ok.filter((s) => (s.tool_calls ?? 0) > 0).map((s) => s.wall_ms);
  const withoutTools = ok.filter((s) => (s.tool_calls ?? 0) === 0).map((s) => s.wall_ms);
  const toolsStats = summarize(withTools);
  const noToolsStats = summarize(withoutTools);

  const slowest = [...ok].sort((a, b) => b.wall_ms - a.wall_ms).slice(0, 5).map((s) => ({
    id: s.id,
    intent: s.actual_intent ?? s.intent,
    wall_ms: s.wall_ms,
    steps: s.steps,
    tool_calls: s.tool_calls,
  }));

  const payload = {
    id: 's08',
    name: 'Agent 全链路延迟分位',
    status: 'pass',
    metric: `P50=${all.p50}ms  P95=${all.p95}ms  P99=${all.p99}ms（n=${all.n}）`,
    target: '记录型指标（无硬目标），关注长尾',
    conclusion:
      `整轮对话 P50=${all.p50}ms、P95=${all.p95}ms。` +
      `带工具调用的轮次 P50=${toolsStats.p50}ms，零工具轮次 P50=${noToolsStats.p50}ms —— ` +
      `差值即检索+切题评估的成本`,
    sample_count: all.n,
    overall: all,
    by_intent: byIntent,
    with_tools: toolsStats,
    without_tools: noToolsStats,
    slowest_5: slowest,
    source: { samples: 'samples.json（由 s07 采集）', rounds: samples.length / (new Set(samples.map((s) => s.id)).size || 1) },
    caveats: [
      '延迟为客户端 wall time（含网络、鉴权、服务端处理），与服务端自报耗时不混用',
      '样本来自同一台开发机与同一后端进程，是单机表现，不等于生产容量',
      'P99 基于 100 条样本，仅作参考，不足以支撑稳定性承诺',
      's08 与 s06 测的不是一回事：s06 是检索接口，s08 是整轮对话',
    ],
  };
  writeItemJson(suiteDir, 's08-agent-latency', payload);

  console.log(`  整体 P50=${all.p50}ms  P95=${all.p95}ms  P99=${all.p99}ms  (n=${all.n})`);
  console.log('  按意图：');
  for (const [k, v] of Object.entries(byIntent)) {
    console.log(`    ${k.padEnd(20)} n=${String(v.n).padEnd(3)} P50=${v.p50}ms  P95=${v.p95}ms`);
  }
  console.log(`  带工具 n=${toolsStats.n} P50=${toolsStats.p50}ms ｜ 零工具 n=${noToolsStats.n} P50=${noToolsStats.p50}ms`);
  console.log('  最慢 5 条：');
  for (const s of slowest) {
    console.log(`    ${s.id} ${String(s.intent).padEnd(18)} ${(s.wall_ms / 1000).toFixed(1)}s  steps=${s.steps} tools=${s.tool_calls}`);
  }
  console.log(`  明细：${join(suiteDir, 's08-agent-latency.json')}`);
}

main();
