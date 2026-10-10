#!/usr/bin/env node
/**
 * 检索方案消融对照（补「方案对比卡 · 卡 1」的证据缺口）
 *
 * 卡 1 的空白是：只有「双路 + RRF 跑通了」，**没有单路对照**，因此
 * 「为什么不用纯向量 / 纯 BM25」只能靠设计判断，且「双路 vs 单路的延迟代价」只有
 * 一个全链路 1083ms 的绝对值，无法拆分。
 *
 * 本脚本把这三件事变成数字：
 *   1. 单路质量对照——bm25 / knn / hybrid 三臂跑同一批带 ground truth 的用例
 *   2. 延迟拆解——用 /rag/search 返回的 stages（embed / knn / bm25 / fuse / rerank）
 *   3. 逐条命中差异——哪条 query 只有 BM25 召回、哪条只有向量召回（WHY-NOT 的直接证据）
 *
 * 被测开关是 /rag/search 的 `mode` 查询参数（hybrid | bm25 | knn），由后端 DTO 校验，
 * 默认 hybrid 即生产行为；因此本脚本不改被测代码语义，只改被测参数。
 *
 * 用法：node test/eval/retrieval-ablation.mjs
 * 可选环境变量：
 *   EVAL_BASE_URL  默认 http://localhost:3000
 *   EVAL_ONLY      逗号分隔用例 id
 *   ABLATION_OUT   结果 markdown 落盘路径
 *   ABLATION_JSON  结果 JSON 落盘路径
 *
 * 前置：后端已启动；dataset.json 内语料已上传并发布。
 */

import 'dotenv/config';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const BASE = process.env.EVAL_BASE_URL ?? 'http://localhost:3000';
const USERNAME = process.env.EVAL_USERNAME ?? 'admin';
const PASSWORD = process.env.EVAL_PASSWORD ?? '123456';
const HERE = dirname(fileURLToPath(import.meta.url));

const dataset = JSON.parse(
  readFileSync(join(HERE, process.env.EVAL_DATASET ?? 'dataset.json'), 'utf8'),
);
const K = dataset.k ?? 5;

/**
 * 八臂 = 4 种融合/召回模式 × rerank 开/关。
 * rerank=on 的四臂回答「召回与融合方案怎么选」；rerank=off 的四臂回答「精排在每种召回下值多少」。
 * `hybrid_weighted` 是针对「为什么用 RRF 而不是加权求和」的对照臂：
 * RRF 只用排名 → 两路各自 Top-1 必然同分（见 rrfFuse 注释），加权求和保留单路内部分差。
 */
const ARMS = [
  { key: 'hybrid_rerank', mode: 'hybrid', rerank: true, label: 'RRF 双路 + 精排（生产配置）' },
  { key: 'hybrid_rrf', mode: 'hybrid', rerank: false, label: 'RRF 双路 仅排序（卡2 baseline）' },
  { key: 'weighted_rerank', mode: 'hybrid_weighted', rerank: true, label: '加权求和双路 + 精排' },
  { key: 'weighted_rrf', mode: 'hybrid_weighted', rerank: false, label: '加权求和双路 仅排序' },
  { key: 'bm25_rerank', mode: 'bm25', rerank: true, label: '纯 BM25 + 精排（卡1 baseline）' },
  { key: 'bm25_rrf', mode: 'bm25', rerank: false, label: '纯 BM25 仅排序' },
  { key: 'knn_rerank', mode: 'knn', rerank: true, label: '纯向量 KNN + 精排' },
  { key: 'knn_rrf', mode: 'knn', rerank: false, label: '纯向量 KNN 仅排序' },
];

const msg = (err) => (err instanceof Error ? err.message : String(err));

async function login() {
  const res = await fetch(`${BASE}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: USERNAME, password: PASSWORD }),
  });
  if (!res.ok) throw new Error(`登录失败 ${res.status}`);
  const data = await res.json();
  if (!data.accessToken) throw new Error('登录响应缺少 accessToken');
  return data.accessToken;
}

/** 单次检索：返回返回顺序的 titles、端到端 took_ms、后端自报的分阶段耗时 */
async function searchOnce(token, q, mode, rerank) {
  const url =
    `${BASE}/rag/search?q=${encodeURIComponent(q)}` +
    `&top_k=${K}&rerank=${rerank}&mode=${mode}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) {
    const body = (await res.text()).slice(0, 200);
    throw new Error(`/rag/search ${res.status}: ${body}`);
  }
  const data = await res.json();
  const items = Array.isArray(data.items) ? data.items : [];
  return {
    titles: items.map((it) => it.doc_title),
    tookMs: data.took_ms ?? null,
    stages: data.stages ?? null,
    modeEcho: data.mode ?? null,
  };
}

/**
 * 检索层指标（口径固定如下，报告里必须一致引用）：
 * - recall@K    = 命中的**期望文档数** / 期望文档总数；按文档去重，取值上限 1
 *                 （同一文档的多个 chunk 同时进入 Top-K 只算一次，否则 recall 会 >1）
 * - precision@K = Top-K 中来自期望文档的**去重文档数** / K
 * - mrr         = 首个命中（按 chunk 位次）的倒数排名
 * - hit@K       = Top-K 内是否存在命中，0/1
 */
function retrievalMetrics(expectedTitles, titles) {
  const expected = new Set(expectedTitles);
  const topK = titles.slice(0, K);
  const hitChunks = topK.filter((t) => expected.has(t));
  const hitDocCount = new Set(hitChunks).size;
  const firstIdx = topK.findIndex((t) => expected.has(t));
  return {
    recall_at_k: expected.size > 0 ? Math.min(1, hitDocCount / expected.size) : 0,
    precision_at_k: hitDocCount / K,
    mrr: firstIdx >= 0 ? 1 / (firstIdx + 1) : 0,
    hit_at_k: hitChunks.length > 0 ? 1 : 0,
    first_hit_rank: firstIdx >= 0 ? firstIdx + 1 : null,
  };
}

const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const percentile = (xs, p) => {
  if (!xs.length) return 0;
  const sorted = [...xs].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[idx];
};
const fmt = (v, d = 3) => (v === null || v === undefined ? '—' : Number(v).toFixed(d));

const STAGE_KEYS = ['embed_ms', 'knn_ms', 'bm25_ms', 'fuse_ms', 'rerank_ms'];

async function main() {
  const only = process.env.EVAL_ONLY
    ? new Set(process.env.EVAL_ONLY.split(',').map((s) => s.trim()).filter(Boolean))
    : null;
  const cases = (dataset.items ?? []).filter(
    (it) => (!only || only.has(it.id)) && (it.expected_doc_titles ?? []).length > 0,
  );
  if (!cases.length) throw new Error('没有可用用例（需带 expected_doc_titles）');

  console.log(`\n检索消融对照  base=${BASE}  K=${K}  用例=${cases.length}  臂=${ARMS.length}\n`);
  const token = await login();

  /** perArm[armKey] = { metrics: [], took: [], stages: {key: []} } */
  const perArm = Object.fromEntries(
    ARMS.map((a) => [a.key, { metrics: [], took: [], stages: Object.fromEntries(STAGE_KEYS.map((s) => [s, []])) }]),
  );
  const rows = [];

  for (const item of cases) {
    const row = { id: item.id, q: item.question, expected: (item.expected_doc_titles ?? []).join(' / ') };
    for (const arm of ARMS) {
      try {
        const r = await searchOnce(token, item.question, arm.mode, arm.rerank);
        const m = retrievalMetrics(item.expected_doc_titles, r.titles);
        perArm[arm.key].metrics.push(m);
        if (r.tookMs !== null) perArm[arm.key].took.push(r.tookMs);
        if (r.stages) {
          for (const s of STAGE_KEYS) perArm[arm.key].stages[s].push(r.stages[s] ?? 0);
        }
        row[arm.key] = { ...m, tookMs: r.tookMs, top1: r.titles[0] ?? '（空）', topTitles: r.titles };
      } catch (err) {
        row[arm.key] = { error: msg(err) };
      }
    }
    rows.push(row);
    console.log(
      `${item.id}  首条命中位次  bm25=${row.bm25_rerank.first_hit_rank ?? '—'}` +
        `  knn=${row.knn_rerank.first_hit_rank ?? '—'}  hybrid=${row.hybrid_rerank.first_hit_rank ?? '—'}` +
        (row.hybrid_rerank.error ? `  ⚠️ ${row.hybrid_rerank.error}` : ''),
    );
  }

  const summary = ARMS.map((arm) => {
    const b = perArm[arm.key];
    return {
      key: arm.key,
      arm: arm.label,
      mode: arm.mode,
      rerank: arm.rerank,
      recall_at_k: mean(b.metrics.map((m) => m.recall_at_k)),
      precision_at_k: mean(b.metrics.map((m) => m.precision_at_k)),
      mrr: mean(b.metrics.map((m) => m.mrr)),
      hit_at_k: mean(b.metrics.map((m) => m.hit_at_k)),
      took_mean: mean(b.took),
      took_p50: percentile(b.took, 50),
      took_p95: percentile(b.took, 95),
      stages: Object.fromEntries(STAGE_KEYS.map((s) => [s, mean(b.stages[s])])),
      n: b.metrics.length,
    };
  });

  const lines = [];
  lines.push(`# 检索消融对照结果（K=${K}，用例 ${cases.length} 条）`);
  lines.push('');
  lines.push('> 口径：直连 `GET /rag/search`，`mode` 为后端检索消融开关（hybrid 为生产默认）；');
  lines.push('> ground truth = 数据集文件的 `expected_doc_titles`，按**标题精确匹配**；');
  lines.push('> 四指标口径：`recall@K`=命中期望文档数/期望文档总数（**按文档去重**，上限 1）；');
  lines.push('> `precision@K`=Top-K 中来自期望文档的去重文档数/K；`MRR`=首个命中位次的倒数；`Hit@K`=Top-K 内是否命中；');
  lines.push('> `took_ms` = 端到端（含查询向量化 + 召回 + 融合 + 精排 + 服务端处理）；');
  lines.push('> stages 为后端自报分阶段耗时均值，knn/bm25 在 hybrid 下并行，故两者之和会大于端到端差。');
  lines.push('');
  lines.push(`| 方案 | mode | rerank | Recall@${K} | Precision@${K} | MRR | Hit@${K} | 延迟均值 ms | 延迟 P50 ms | 延迟 P95 ms |`);
  lines.push('| :--- | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: |');
  for (const s of summary) {
    lines.push(
      `| ${s.arm} | ${s.mode} | ${s.rerank ? 'on' : 'off'} | ${fmt(s.recall_at_k)} | ${fmt(s.precision_at_k)} | ` +
        `${fmt(s.mrr)} | ${fmt(s.hit_at_k)} | ${fmt(s.took_mean, 1)} | ${fmt(s.took_p50, 1)} | ${fmt(s.took_p95, 1)} |`,
    );
  }
  lines.push('');
  lines.push('## 分阶段耗时（均值 ms）');
  lines.push('');
  lines.push('| 方案 | embed | knn | bm25 | fuse | rerank |');
  lines.push('| :--- | :-: | :-: | :-: | :-: | :-: |');
  for (const s of summary) {
    lines.push(
      `| ${s.key} | ${fmt(s.stages.embed_ms, 1)} | ${fmt(s.stages.knn_ms, 1)} | ${fmt(s.stages.bm25_ms, 1)} | ` +
        `${fmt(s.stages.fuse_ms, 1)} | ${fmt(s.stages.rerank_ms, 1)} |`,
    );
  }
  lines.push('');
  lines.push('## 逐用例命中位次（rerank=on）');
  lines.push('');
  lines.push('| 用例 | 期望文档 | BM25 | KNN | 混检 | BM25 top1 | KNN top1 |');
  lines.push('| :--- | :--- | :-: | :-: | :-: | :--- | :--- |');
  for (const r of rows) {
    lines.push(
      `| ${r.id} | ${r.expected} | ${r.bm25_rerank.first_hit_rank ?? '—'} | ${r.knn_rerank.first_hit_rank ?? '—'} | ` +
        `${r.hybrid_rerank.first_hit_rank ?? '—'} | ${r.bm25_rerank.top1 ?? '—'} | ${r.knn_rerank.top1 ?? '—'} |`,
    );
  }
  lines.push('');
  lines.push('## 逐用例明细（各臂返回顺序）');
  lines.push('');
  for (const r of rows) {
    lines.push(`### ${r.id}　${r.q}`);
    lines.push('');
    lines.push(`- 期望文档：${r.expected}`);
    for (const arm of ARMS) {
      const a = r[arm.key];
      lines.push(
        `- ${arm.label}：首条命中 ${a.first_hit_rank ?? '—'}　召回 ${(a.topTitles ?? []).join(' / ') || '（空）'}`,
      );
    }
    lines.push('');
  }

  const out = lines.join('\n');
  console.log('\n' + out + '\n');

  if (process.env.ABLATION_OUT) {
    writeFileSync(process.env.ABLATION_OUT, out, 'utf8');
    console.log(`已写入 ${process.env.ABLATION_OUT}`);
  }
  if (process.env.ABLATION_JSON) {
    writeFileSync(
      process.env.ABLATION_JSON,
      JSON.stringify({ generatedAt: new Date().toISOString(), base: BASE, k: K, summary, rows }, null, 2),
      'utf8',
    );
    console.log(`已写入 ${process.env.ABLATION_JSON}`);
  }
}

main().catch((err) => {
  console.error(`运行失败：${msg(err)}`);
  process.exit(1);
});
