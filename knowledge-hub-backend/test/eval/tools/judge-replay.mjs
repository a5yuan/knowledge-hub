#!/usr/bin/env node
/**
 * judge 稳定性重放（工单 24 · s05 排障工具）
 *
 * 为什么需要：s05 的支撑性同一份代码连跑两次得到 100% / 90%，分不清是
 * ① 模型回答变了（对话抖动） 还是 ② judge 自己判得不一样。
 * 本工具只重放 **已有的 sentence + excerpt**，不重新对话 —— 输入完全固定，
 * 那么结果差异就只能是 judge 自身不稳定。
 *
 * 用法：
 *   node test/eval/tools/judge-replay.mjs test/eval/results/suite-p0/s05-manual-samples.json 3
 *
 * 判据：逐条一致率 ≥ 90% 视为 judge 稳定；低于这个值，支撑性数字的抖动主要来自 judge，
 * 需要收紧 prompt 口径或改「多次投票取多数」。
 */
import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { judgeSupport } from '../lib/judge.mjs';

const file = process.argv[2];
const times = Number(process.argv[3] ?? 3);
if (!file) {
  console.error('用法：node test/eval/tools/judge-replay.mjs <manual-samples.json> [times]');
  process.exit(2);
}

const cfg = {
  base: process.env.EMBEDDING_BASE_URL ?? '',
  key: process.env.OPENAI_API_KEY ?? '',
  model: process.env.EVAL_JUDGE_MODEL ?? 'qwen-plus',
};

const samples = JSON.parse(readFileSync(file, 'utf8')).samples ?? [];
console.log(`judge=${cfg.model}　样本 ${samples.length} 条　每条判 ${times} 次`);
console.log('='.repeat(74));

const perItem = [];
for (const [i, s] of samples.entries()) {
  const verdicts = [];
  for (let t = 0; t < times; t++) {
    try {
      const v = await judgeSupport(cfg, s.question, s.sentence, s.excerpt ?? '');
      verdicts.push(v.verdict);
    } catch (err) {
      verdicts.push(`err:${String(err.message).slice(0, 20)}`);
    }
  }
  const uniq = [...new Set(verdicts)];
  const stable = uniq.length === 1;
  perItem.push({ no: s.no ?? i + 1, verdicts, stable });
  console.log(
    `#${String(s.no ?? i + 1).padStart(2)} ${stable ? '✅' : '⚠️ '} ${verdicts.join(' / ')}` +
      `　${(s.sentence ?? '').slice(0, 42)}`,
  );
}

const stableCount = perItem.filter((x) => x.stable).length;
const rate = perItem.length ? stableCount / perItem.length : 0;

// 多数投票后的结果分布
const majority = perItem.map((x) => {
  const c = {};
  for (const v of x.verdicts) c[v] = (c[v] ?? 0) + 1;
  return Object.entries(c).sort((a, b) => b[1] - a[1])[0][0];
});
const dist = majority.reduce((acc, v) => ((acc[v] = (acc[v] ?? 0) + 1), acc), {});

console.log('-'.repeat(74));
console.log(`逐条一致率 ${(rate * 100).toFixed(0)}%（${stableCount}/${perItem.length}）`);
console.log(`多数投票后的分布：${JSON.stringify(dist)}`);
console.log(
  rate >= 0.9
    ? '→ judge 稳定，支撑性的抖动主要来自模型回答本身'
    : '→ judge 自身不稳定：同一份输入判出不同结论，支撑性数字不可直接比较',
);
