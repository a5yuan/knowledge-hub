#!/usr/bin/env node
/**
 * s01 · 检索质量 Recall@K / MRR / Hit@K（工单 24 指标 #1）
 *
 * **不重跑评测**，而是解析 `run-eval.mjs` 产出的 `eval-report.md`。
 * 原因：`run-eval` 是 14 条 × LLM judge 的完整评测（约 5 分钟 + 真实模型调用），
 * 每跑一次都要烧 judge 额度；而它的产物已经是结构化表格，解析足够可复现。
 *
 * 前置：`test/eval/eval-report.md` 存在（由 `node test/eval/run-eval.mjs` 生成）。
 *
 * ⚠️ precision_at_k 恒为 0.20 是**语料粒度**导致的，不是检索精度问题：
 * 演示语料只有 4 篇短制度文档，每篇 1 个 chunk；K=5 时返回 5 条命中 1 篇 → 1/5 = 0.2。
 * 报告里必须带上这个解释，否则会被误读成"检索精度只有 20%"。
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createSuiteDir, writeItemJson, EVAL_ROOT } from '../lib/report.mjs';

const REPORT = join(EVAL_ROOT, 'eval-report.md');

/** 从 markdown 的「总览」表里抓指标行 */
function parseOverview(md) {
  const out = {};
  // 形如：| recall_at_k | 1.000 | 10 |
  const re = /^\|\s*([a-z_]+)\s*\|\s*([\d.]+|—)\s*\|\s*(\d+)\s*\|$/gm;
  let m;
  while ((m = re.exec(md)) !== null) {
    out[m[1]] = { value: m[2] === '—' ? null : Number(m[2]), n: Number(m[3]) };
  }
  return out;
}

function main() {
  const suiteDir = process.env.SUITE_DIR ?? createSuiteDir();
  console.log('s01 · 检索质量（复用 eval-report.md）');

  if (!existsSync(REPORT)) {
    console.log('  ❌ 缺少 eval-report.md，先跑 `node test/eval/run-eval.mjs`');
    writeItemJson(suiteDir, 's01-retrieval', {
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

  const pick = (k) => metrics[k] ?? { value: null, n: 0 };
  const recall = pick('recall_at_k');
  const precision = pick('precision_at_k');
  const mrr = pick('mrr');
  const hit = pick('hit_at_k');

  const ok = recall.value === 1 && mrr.value === 1 && hit.value === 1;

  const payload = {
    id: 's01',
    name: '检索质量 Recall@K / MRR / Hit@K',
    status: ok ? 'pass' : 'fail',
    metric: `R@5=${recall.value ?? '—'}  MRR=${mrr.value ?? '—'}  Hit@5=${hit.value ?? '—'}`,
    target: 'R@5 / MRR / Hit@5 越接近 1 越好',
    conclusion: ok
      ? `K=5 下全部命中且首次命中即为期望文档（${recall.n} 条有效用例）`
      : '存在未命中或排序偏差，详见 eval-report.md',
    source: { report: 'test/eval/eval-report.md', runName, ranAt },
    metrics: {
      recall_at_k: recall,
      precision_at_k: precision,
      mrr,
      hit_at_k: hit,
    },
    caveats: [
      'precision_at_k=0.20 由语料粒度决定：4 篇短文档各 1 个 chunk，K=5 时命中 1 篇 → P@5=0.2，不代表检索精度差',
      '有效用例数小于总用例数，因为 no_result 类用例不计算检索指标（本就没有正确答案）',
      '演示语料仅 4 篇制度文档，满分说明的是「在小语料上稳定命中」，不能外推为大库表现',
    ],
  };
  writeItemJson(suiteDir, 's01-retrieval', payload);

  console.log(`  R@5=${recall.value}  MRR=${mrr.value}  Hit@5=${hit.value}  P@5=${precision.value}`);
  console.log(`  ${ok ? '✅ 通过' : '❌ 失败'}　来源：${runName} @ ${ranAt}`);
  console.log(`  明细：${join(suiteDir, 's01-retrieval.json')}`);
  if (!ok) process.exitCode = 1;
}

main();
