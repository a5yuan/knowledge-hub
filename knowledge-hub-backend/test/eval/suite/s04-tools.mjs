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
import { resolveSuiteDir, writeItemJson, writeItemLog, EVAL_ROOT } from '../lib/report.mjs';

const MISS_TARGET = 0.15; // 漏调率上限
const EXTRA_TARGET = 1; // 单条多余调用上限

/** 全部工具名（与 src/ai/ai-agent.service.ts 的 allTools 一致） */
const ALL_TOOLS = ['retrieve_knowledge', 'retrieve_graph', 'rewrite_query', 'web_search'];

function main() {
  const suiteDir = resolveSuiteDir();
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

  /**
   * optional_call 从标注集兜底读：老样本没这个字段时也能按新口径算，
   * 不必为了加一个字段把 50 条请求重跑一遍。
   */
  let optionalById = new Map();
  try {
    const set = JSON.parse(
      readFileSync(join(EVAL_ROOT, 'intent-set.json'), 'utf8'),
    );
    optionalById = new Map(
      (set.items ?? []).map((it) => [it.id, it.optional_call ?? []]),
    );
  } catch {
    /* 标注集读不到就退化：没人有 optional */
  }

  let mustTotal = 0;
  let missed = 0;
  let extraRows = 0;
  let maxExtra = 0;
  const rows = [];
  const logLines = [];
  /** 预检索已登记来源、所以「不必再调 retrieve_knowledge」的条目（不计入分母） */
  const preCoveredRows = [];

  for (const s of samples) {
    const must = s.expected_must_call ?? [];
    const called = ALL_TOOLS.filter((t) => (s.tools?.[t] ?? 0) > 0);
    // 只认知识库类来源：web 来源不代表「查过库」
    const sources = s.kb_sources_count ?? 0;

    /**
     * 漏调口径（2026-10-21 修正，第一版是错的）：
     *
     * `INTENT_DIRECTIVES.knowledge` 明写「已有【知识库检索资料】属预检索结果：
     * 足以回答则直接作答；为空或不足时必须调用 retrieve_knowledge」，
     * 且前置管线的来源与工具共用同一个引用池。所以**预检索已命中时，不调工具是设计内行为**，
     * 把它算成「漏调」会系统性高估。
     *
     * 正确口径：retrieve_knowledge 只在「预检索也是空的（sources_count==0）」时才必须调；
     * web_search 没有预检索兜底，must 里列了就一直是必须。
     */
    const applies = []; // 计入分母的 must 项
    const missedTools = [];
    for (const t of must) {
      if (called.includes(t)) {
        applies.push(t); // 调了 → 命中
        continue;
      }
      if (t === 'retrieve_knowledge' && (sources > 0 || s.forced_retrieve)) {
        preCoveredRows.push({
          id: s.id,
          question: s.question,
          sources,
          forced: !!s.forced_retrieve,
        });
        continue; // 预检索命中 或 代码已代调 → 不计入分母
      }
      applies.push(t); // 该调没调 → 漏
      missedTools.push(t);
    }
    // optional_call 里的工具（如 k_t_w 的 web_search）调了不算多余
    const optional = s.expected_optional_call ?? optionalById.get(s.id) ?? [];
    const extraTools = called.filter((t) => !must.includes(t) && !optional.includes(t));

    mustTotal += applies.length;
    missed += missedTools.length;
    if (extraTools.length > 0) extraRows += 1;
    maxExtra = Math.max(maxExtra, extraTools.length);

    rows.push({
      id: s.id,
      question: s.question,
      expected_intent: s.expected_intent,
      must_call: must,
      called,
      sources_count: sources,
      kb_sources_count: s.kb_sources_count ?? null,
      applies,
      missed: missedTools,
      extra: extraTools,
      tool_calls: s.tool_calls,
    });

    if (missedTools.length || extraTools.length) {
      logLines.push(
        `- [${s.id}] ${s.question}（预检索来源 ${sources} 条）\n  应调 ${JSON.stringify(must)}；实际 ${JSON.stringify(called)}` +
          `${missedTools.length ? `；漏调 ${JSON.stringify(missedTools)}` : ''}` +
          `${extraTools.length ? `；多余 ${JSON.stringify(extraTools)}` : ''}`,
      );
    }
  }

  // ── 工具级 P/R ──────────────────────────────────────────────
  /** 某工具「真正该调」的条目：must 里列了，且不是「预检索已覆盖」那种 */
  const appliesFor = (s, t) => {
    if (!(s.expected_must_call ?? []).includes(t)) return false;
    const called = (s.tools?.[t] ?? 0) > 0;
    if (t === 'retrieve_knowledge' && !called && ((s.kb_sources_count ?? s.sources_count ?? 0) > 0 || s.forced_retrieve))
      return false;
    return true;
  };

  const perTool = ALL_TOOLS.map((t) => {
    const expectedRows = samples.filter((s) => appliesFor(s, t));
    const calledRows = samples.filter((s) => (s.tools?.[t] ?? 0) > 0);
    const tp = calledRows.filter((s) => appliesFor(s, t)).length;
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
  if (preCoveredRows.length) {
    console.log(
      `预检索已覆盖、无需调 retrieve_knowledge：${preCoveredRows.length} 条（从分母剔除）`,
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
    pre_covered_rows: preCoveredRows,
    extra_rows: extraRows,
    max_extra_per_row: maxExtra,
    per_tool: perTool,
    rows,
    caveats: [
      '22 号工单后工具常驻，口径是「实际调用了哪些」而非「下发了哪些」——下发集合恒为 4 个，不再有区分度',
      '多余调用不一定是错：knowledge_then_web 里调 web_search 是允许的，所以 web_search 的 precision 会偏低（分母含合法的补查）',
      'must_call 来自 intent-set.json 的标注，标签未人工确认时该指标同样是自一致性基线',
      's04 不单独发请求，直接复用 s03 的样本，sample_size 与 s03 相同',
      '漏调口径已修正：前置预检索登记了来源（sources_count>0）时，「不调 retrieve_knowledge」是 INTENT_DIRECTIVES 允许的行为，已从分母剔除。第一版把它算成漏调，系统性高估了漏调率',
    ],
  };

  writeItemJson(suiteDir, 's04-tools', payload);
  writeItemLog(suiteDir, 's04-tools', logLines.join('\n\n') || '（无漏调/多余调用）');

  console.log('='.repeat(70));
  console.log(`结论：${payload.conclusion}`);
  if (status !== 'pass') process.exitCode = 1;
}

main();
