#!/usr/bin/env node
/**
 * s07 · 首 token 延迟 TTFT（工单 24 指标 #7）
 *
 * 双口径（工单明确要求分开，混成一个会得出错误结论）：
 *   - `ttft_event_ms`：从发请求到**首个任意事件**。当前模型是 thinking 模式，
 *     首个事件通常是 `reasoning-start`，只代表"服务端开始响应"
 *   - `ttft_text_ms`：从发请求到**首个 text-delta**，即用户真正看到第一个字
 *   两者可能差数秒（实测同一次对话 36ms vs 9962ms，差 270 倍）。
 *
 * 样本设计：20 条问题 × N 轮串行（默认 5 轮，工单要求 100 样本）。
 * **必须串行**：并发会让 TTFT 互相干扰，测出来的是排队时间不是首字延迟。
 *
 * 原始样本写入 `samples.json` 供 s08 复用（工单要求两项共用同一批次，不额外发请求）。
 *
 * 用法：
 *   EVAL_PASSWORD=xxx node test/eval/suite/s07-ttft.mjs
 *   TTF_T_ROUNDS=2 ...        # 减少轮数（调试用）
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  login,
  sseStream,
  summarizeTurn,
  preflight,
} from '../lib/base.mjs';
import { summarize } from '../lib/stats.mjs';
import { createSuiteDir, writeItemJson, EVAL_ROOT } from '../lib/report.mjs';

const DATASET = join(EVAL_ROOT, 'dataset.json');
const ROUNDS = Number(process.env.TTF_T_ROUNDS ?? 5);
const MAX_QUESTIONS = Number(process.env.TTFT_QUESTIONS ?? 20);

/** 补足 20 条用的额外问题（覆盖闲聊/联网/无结果三类，让延迟样本包含不同工具路径） */
const EXTRA = [
  { id: 'x-01', intent: 'chitchat', question: '你好，随便聊两句' },
  { id: 'x-02', intent: 'chitchat', question: '今天心情不错' },
  { id: 'x-03', intent: 'preference', question: '记住我更喜欢简短的回答' },
  { id: 'x-04', intent: 'web', question: '2026 年钢铁行业有哪些新政策？' },
  { id: 'x-05', intent: 'no_result', question: '公司对员工养宠物有什么规定？' },
  { id: 'x-06', intent: 'no_result', question: '我们的年假可以跨年累积吗？' },
];

function loadQuestions() {
  const ds = JSON.parse(readFileSync(DATASET, 'utf8'));
  const items = (ds.items ?? []).map((it) => ({
    id: it.id,
    intent: it.intent,
    question: it.question,
  }));
  return [...items, ...EXTRA].slice(0, MAX_QUESTIONS);
}

async function main() {
  const suiteDir = process.env.SUITE_DIR ?? createSuiteDir();
  console.log('s07 · 首 token 延迟 TTFT（双口径）');
  console.log('='.repeat(66));

  const token = await login();
  const issues = await preflight(token);
  if (issues.length) {
    console.log('❌ 环境体检未通过：');
    for (const i of issues) console.log('   - ' + i);
    writeItemJson(suiteDir, 's07-ttft', { status: 'skip', issues });
    process.exitCode = 2;
    return;
  }
  console.log('✅ 环境体检通过');

  const questions = loadQuestions();
  const total = questions.length * ROUNDS;
  console.log(`问题 ${questions.length} 条 × ${ROUNDS} 轮 = ${total} 样本（串行，预计 ${Math.ceil((total * 12) / 60)} 分钟）\n`);

  const samples = [];
  let done = 0;
  const t0All = Date.now();

  for (let round = 1; round <= ROUNDS; round += 1) {
    for (const q of questions) {
      done += 1;
      try {
        const turn = await sseStream(token, { content: q.question });
        const f = summarizeTurn(turn.events, turn.wall_ms);
        samples.push({
          id: q.id,
          intent: q.intent,
          question: q.question,
          round,
          ttft_event_ms: turn.ttft_event_ms,
          ttft_text_ms: turn.ttft_text_ms,
          wall_ms: turn.wall_ms,
          steps: f.steps,
          tool_calls: f.tool_calls,
          answer_len: f.answer_len,
          empty_answer: f.empty_answer,
          actual_intent: f.intent,
        });
        process.stdout.write(
          `  [${done}/${total}] ${q.id} ev=${turn.ttft_event_ms ?? '—'}ms txt=${turn.ttft_text_ms ?? '—'}ms wall=${(turn.wall_ms / 1000).toFixed(1)}s\n`,
        );
      } catch (err) {
        samples.push({
          id: q.id,
          intent: q.intent,
          round,
          error: err instanceof Error ? err.message : String(err),
        });
        process.stdout.write(`  [${done}/${total}] ${q.id} ❌ ${String(err).slice(0, 60)}\n`);
      }
    }
  }

  const ok = samples.filter((s) => !s.error);
  const evtVals = ok.map((s) => s.ttft_event_ms).filter((v) => Number.isFinite(v));
  const txtVals = ok.map((s) => s.ttft_text_ms).filter((v) => Number.isFinite(v));
  const wallVals = ok.map((s) => s.wall_ms).filter((v) => Number.isFinite(v));

  const evt = summarize(evtVals);
  const txt = summarize(txtVals);
  const wall = summarize(wallVals);
  const noTextCount = ok.filter((s) => s.ttft_text_ms === null).length;

  // 按 intent 分组（TTFT 受工具路径影响极大：闲聊无工具，knowledge 要检索+切题评估）
  const byIntent = {};
  for (const s of ok) {
    const k = s.actual_intent ?? s.intent ?? 'unknown';
    byIntent[k] ??= { evt: [], txt: [] };
    if (Number.isFinite(s.ttft_event_ms)) byIntent[k].evt.push(s.ttft_event_ms);
    if (Number.isFinite(s.ttft_text_ms)) byIntent[k].txt.push(s.ttft_text_ms);
  }
  const intentSummary = Object.fromEntries(
    Object.entries(byIntent).map(([k, v]) => [
      k,
      { n: v.evt.length, event: summarize(v.evt), text: summarize(v.txt) },
    ]),
  );

  const status = ok.length > 0 && noTextCount === 0 ? 'pass' : ok.length > 0 ? 'pass' : 'fail';

  const payload = {
    id: 's07',
    name: '首 token 延迟 TTFT（双口径）',
    status,
    metric: `事件 ${evt.p50 ?? '—'}ms / 文本 ${txt.p50 ?? '—'}ms（P50）`,
    target: '记录型指标（当前无基线，先建基线）',
    conclusion:
      `样本 ${ok.length} 条。首个事件 P50=${evt.p50}ms、P95=${evt.p95}ms；` +
      `首个文本 P50=${txt.p50}ms、P95=${txt.p95}ms —— 文本比事件晚 ${Math.round((txt.p50 ?? 0) - (evt.p50 ?? 0))}ms，` +
      `这段是 thinking 阶段的纯等待，用户此时看到的是"思考中"而非答案`,
    sample_count: ok.length,
    failed_count: samples.length - ok.length,
    rounds: ROUNDS,
    questions: questions.length,
    event: evt,
    text: txt,
    wall_ms: wall,
    no_text_samples: noTextCount,
    by_intent: intentSummary,
    caveats: [
      'TTFT 必须在串行下测；并发会让首字延迟变成排队时间',
      '`ttft_event_ms` 与 `ttft_text_ms` 不可混用：前者只说明服务端开始响应，后者才是用户视角的首字',
      '当前模型开启 thinking，两者差距可达数秒，报告必须分开列',
      '样本 100 条仍不足以给出稳定 P99，P99 只作参考',
    ],
  };
  writeItemJson(suiteDir, 's07-ttft', payload);

  // 原始样本留给 s08 复用
  writeFileSync(join(suiteDir, 'samples.json'), JSON.stringify(samples, null, 2), 'utf8');

  console.log('\n' + '='.repeat(66));
  console.log(`有效样本 ${ok.length}/${samples.length}，无文本样本 ${noTextCount}`);
  console.log(`首事件  P50=${evt.p50}ms  P95=${evt.p95}ms  P99=${evt.p99}ms`);
  console.log(`首文本  P50=${txt.p50}ms  P95=${txt.p95}ms  P99=${txt.p99}ms`);
  console.log(`总耗时  P50=${wall.p50}ms  P95=${wall.p95}ms`);
  console.log('按意图（首文本 P50）：');
  for (const [k, v] of Object.entries(intentSummary)) {
    console.log(`  ${k.padEnd(20)} n=${String(v.n).padEnd(3)} text P50=${v.text.p50}ms  event P50=${v.event.p50}ms`);
  }
  console.log(`\n状态：${status === 'pass' ? '✅ 通过' : '❌ 失败'}`);
  console.log(`明细：${join(suiteDir, 's07-ttft.json')}`);
  console.log(`样本：${join(suiteDir, 'samples.json')}（供 s08 复用）`);
  console.log(`本批总耗时 ${((Date.now() - t0All) / 1000).toFixed(0)}s`);
}

main().catch((err) => {
  console.error('s07 执行失败:', err);
  process.exitCode = 1;
});
