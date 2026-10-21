#!/usr/bin/env node
/**
 * s02 · 生成质量 Faithfulness / Relevancy / Completeness / ContextUtil（工单 24 指标 #2）
 *
 * 同 s01：解析 `eval-report.md`，不重跑（judge 每次都要真实模型调用）。
 *
 * ⚠️ 必读的口径说明：
 * - 这是 **LLM-as-judge 的主观分**（5 分制），不是客观真值。judge 本身也是模型，会漂。
 * - 4 项全部出自同一批 14 条用例，样本量小，**不能外推成「生成质量 98 分」这类结论**。
 * - `answer_relevancy` 的有效用例数是 14（含 no_result 类），其余三项是 10 —— 因为
 *   no_result 用例没有检索资料，无从谈 faithfulness / completeness / context utilization。
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createSuiteDir, writeItemJson, EVAL_ROOT } from '../lib/report.mjs';

const REPORT = join(EVAL_ROOT, 'eval-report.md');

function parseOverview(md) {
  const out = {};
  const re = /^\|\s*([a-z_]+)\s*\|\s*([\d.]+|—)\s*\|\s*(\d+)\s*\|$/gm;
  let m;
  while ((m = re.exec(md)) !== null) {
    out[m[1]] = { value: m[2] === '—' ? null : Number(m[2]), n: Number(m[3]) };
  }
  return out;
}

const THRESHOLD = 4.0; // 5 分制下 4.0 = 「良好」，低于则如实标 fail

function main() {
  const suiteDir = process.env.SUITE_DIR ?? createSuiteDir();
  console.log('s02 · 生成质量（复用 eval-report.md）');

  if (!existsSync(REPORT)) {
    console.log('  ❌ 缺少 eval-report.md');
    writeItemJson(suiteDir, 's02-generation', {
      status: 'skip',
      reason: 'eval-report.md 不存在',
    });
    process.exitCode = 2;
    return;
  }

  const md = readFileSync(REPORT, 'utf8');
  const metrics = parseOverview(md);
  const runName = md.match(/run name：`([^`]+)`/)?.[1] ?? '(未知)';
  const ranAt = md.match(/- 时间：(.+)/)?.[1]?.trim() ?? '(未知)';

  const keys = [
    'faithfulness',
    'answer_relevancy',
    'answer_completeness',
    'context_utilization',
  ];
  const values = Object.fromEntries(keys.map((k) => [k, metrics[k] ?? { value: null, n: 0 }]));

  const scored = keys.map((k) => values[k].value).filter((v) => typeof v === 'number');
  const avg = scored.length ? scored.reduce((a, b) => a + b, 0) / scored.length : null;
  const min = scored.length ? Math.min(...scored) : null;
  const ok = min !== null && min >= THRESHOLD;

  const payload = {
    id: 's02',
    name: '生成质量 Faithfulness / Relevancy / Completeness / ContextUtil',
    status: ok ? 'pass' : 'fail',
    metric: keys.map((k) => `${k.slice(0, 12)}=${values[k].value ?? '—'}`).join(' '),
    target: `四项均 ≥ ${THRESHOLD}（5 分制）`,
    conclusion: ok
      ? `四项均达标，最低 ${min.toFixed(2)}（均值 ${avg.toFixed(2)}），扣分项集中在 answer_completeness`
      : `存在低于 ${THRESHOLD} 的项（最低 ${min ?? '—'}）`,
    source: { report: 'test/eval/eval-report.md', runName, ranAt },
    metrics: values,
    average: avg === null ? null : Math.round(avg * 100) / 100,
    caveats: [
      'LLM-as-judge 主观分，judge 与被评模型同源，存在自我偏好风险',
      '样本 10~14 条，不足以支撑「生成质量 X 分」的对外结论',
      'answer_completeness 是四项里最低的（4.60），说明答案常遗漏要点而非编造',
    ],
  };
  writeItemJson(suiteDir, 's02-generation', payload);

  console.log(
    `  ${keys.map((k) => `${k}=${values[k].value}`).join('  ')}`,
  );
  console.log(`  ${ok ? '✅ 通过' : '❌ 失败'}　均值 ${avg?.toFixed(2)}　来源：${runName}`);
  console.log(`  明细：${join(suiteDir, 's02-generation.json')}`);
  if (!ok) process.exitCode = 1;
}

main();
