#!/usr/bin/env node
/**
 * 单路召回消融（Recall Ablation）—— 补「方案对比卡 · 卡 1」的证据缺口
 *
 * 为什么需要它：卡 1 的核心主张是「双路召回必要」和「RRF 优于加权求和」，
 * 但此前**没有任何隔离对照**。而生产代码里**没有关单路的开关**
 * （rag-search.service.ts 只有 RAG_SCORE_THRESHOLD），所以做消融无法靠查参数完成。
 *
 * 本脚本的做法：**不改生产代码**，直接查 ES + 直接调 embedding，
 * ES DSL 与 RRF 实现**逐行复制自生产代码**，从而在不侵入的前提下拿到隔离数字。
 *
 *   复制来源：
 *     - knnSearch  DSL      → src/es/vector-index.service.ts L154-166
 *     - textSearch DSL      → src/es/vector-index.service.ts L184-195
 *     - rrfFuse             → src/rag/rag-search.service.ts L36-54
 *   指标口径与 test/eval/rerank-ab.mjs **完全一致**（按 doc_title 精确匹配，
 *   recall = hits/expected.size、mrr = 1/(firstIdx+1)、K = dataset.k ?? 5），
 *   因此本脚本的数可与 rerank A/B 的结果直接对比。
 *
 * 四个臂：
 *   1. bm25_only      仅关键词路（= 「为什么不用纯 BM25」的对照臂）
 *   2. knn_only       仅向量路（= 「为什么不用纯向量」的对照臂）
 *   3. dual_rrf       双路 + RRF（实际方案）
 *   4. dual_weighted  双路 + 分数归一化加权求和（= 「为什么不用加权求和」的对照臂）
 *
 * 用法：node test/eval/recall-ablation.mjs
 * 可选环境变量：
 *   EVAL_ONLY           逗号分隔用例 id，如 qa-001,qa-005
 *   RECALL_AB_OUT       输出 markdown 路径（默认只打印）
 *   RECALL_AB_WEIGHT    加权求和的 BM25 权重（默认 0.5，即两路等权）
 *
 * 前置：ES 已就绪且 kh_chunk 有数据（**不需要后端**）。
 */

import 'dotenv/config';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ES = (process.env.ES_NODE ?? 'http://localhost:9200').replace(/\/$/, '');
const EMB_URL = (process.env.EMBEDDING_BASE_URL ?? '').replace(/\/$/, '');
const EMB_MODEL = process.env.EMBEDDING_MODEL ?? 'qwen3.7-text-embedding-flash';
const API_KEY = process.env.OPENAI_API_KEY;

/** 与 src/rag/rag-search.service.ts 保持一致的常量 */
const RECALL_SIZE = 50;
const RRF_K = 60;
const CHUNK_INDEX = 'kh_chunk';
const CHUNK_SOURCE_FIELDS = ['doc_id', 'doc_title', 'chunk_index', 'content'];

const dataset = JSON.parse(readFileSync(join(HERE, 'dataset.json'), 'utf8'));
const K = dataset.k ?? 5;
const W_BM25 = Number(process.env.RECALL_AB_WEIGHT ?? 0.5);

const msg = (err) => (err instanceof Error ? err.message : String(err));
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const fmt = (v, d = 3) => (v === null || v === undefined ? '—' : Number(v).toFixed(d));

/** 与生产同构的 RRF：score(d) = Σ 1/(k + rank_i(d))，去重键 doc_id|chunk_index */
function rrfFuse(lists, k = RRF_K) {
  const map = new Map();
  for (const list of lists) {
    list.forEach((hit, i) => {
      const rank = i + 1;
      const key = `${hit.doc_id}|${hit.chunk_index}`;
      const existing = map.get(key);
      if (existing) existing.rrfScore += 1 / (k + rank);
      else map.set(key, { ...hit, rrfScore: 1 / (k + rank) });
    });
  }
  return [...map.values()].sort((a, b) => b.rrfScore - a.rrfScore);
}

/**
 * 加权求和对照臂：各列表 min-max 归一化后按权重相加。
 * ⚠️ 归一化方式本身就是「加权求和方案引入的新参数」（卡 1 WHY-NOT 3 的论点）——
 *    这里选 min-max 是常见做法，换 rank/softmax 归一化结果会变。
 */
function weightedFuse(lists, weights) {
  const map = new Map();
  lists.forEach((list, li) => {
    if (!list.length) return;
    const scores = list.map((h) => h.score ?? 0);
    const min = Math.min(...scores);
    const max = Math.max(...scores);
    const span = max - min;
    list.forEach((hit) => {
      const norm = span > 0 ? ((hit.score ?? 0) - min) / span : 1;
      const key = `${hit.doc_id}|${hit.chunk_index}`;
      const existing = map.get(key);
      const add = norm * (weights[li] ?? 0);
      if (existing) existing.weighted += add;
      else map.set(key, { ...hit, weighted: add });
    });
  });
  return [...map.values()].sort((a, b) => b.weighted - a.weighted);
}

/** 与 test/eval/rerank-ab.mjs 同算法（按 doc_title 精确匹配） */
function retrievalMetrics(expectedTitles, titles) {
  const expected = new Set(expectedTitles);
  const topK = titles.slice(0, K);
  const hits = topK.filter((t) => expected.has(t));
  const firstIdx = topK.findIndex((t) => expected.has(t));
  return {
    recall_at_k: expected.size > 0 ? hits.length / expected.size : 0,
    precision_at_k: hits.length / K,
    mrr: firstIdx >= 0 ? 1 / (firstIdx + 1) : 0,
    hit_at_k: hits.length > 0 ? 1 : 0,
    first_hit_rank: firstIdx >= 0 ? firstIdx + 1 : null,
  };
}

/** 调 dashscope compatible-mode 取查询向量（与生产同端点同模型） */
async function embed(text) {
  const res = await fetch(`${EMB_URL}/embeddings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${API_KEY}` },
    body: JSON.stringify({ model: EMB_MODEL, input: text, dimensions: 1024 }),
  });
  if (!res.ok) throw new Error(`embedding ${res.status}: ${(await res.text()).slice(0, 160)}`);
  const data = await res.json();
  const vec = data?.data?.[0]?.embedding;
  if (!Array.isArray(vec)) throw new Error('embedding 响应缺少向量');
  return vec;
}

function toHits(resp) {
  return (resp.hits?.hits ?? []).map((h) => {
    const s = h._source ?? {};
    return {
      doc_id: s.doc_id ?? '',
      doc_title: s.doc_title ?? '',
      chunk_index: s.chunk_index ?? 0,
      content: s.content ?? '',
      score: h._score ?? 0,
    };
  });
}

async function esSearch(body) {
  const res = await fetch(`${ES}/${CHUNK_INDEX}/_search`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`ES ${res.status}: ${(await res.text()).slice(0, 160)}`);
  return res.json();
}

/** 关键词路 —— DSL 复制自 vector-index.service.ts textSearch() */
function bm25(q) {
  return esSearch({
    size: RECALL_SIZE,
    query: { multi_match: { query: q, fields: ['doc_title^2', 'content'] } },
    _source: CHUNK_SOURCE_FIELDS,
  });
}

/** 向量路 —— DSL 复制自 vector-index.service.ts knnSearch()（含 size 修复） */
function knn(query_vector) {
  return esSearch({
    size: RECALL_SIZE,
    knn: {
      field: 'embedding',
      query_vector,
      k: RECALL_SIZE,
      num_candidates: Math.max(RECALL_SIZE * 2, 100),
    },
    _source: CHUNK_SOURCE_FIELDS,
  });
}

const ARMS = ['bm25_only', 'knn_only', 'dual_rrf', 'dual_weighted'];

async function main() {
  if (!EMB_URL || !API_KEY) throw new Error('缺少 EMBEDDING_BASE_URL / OPENAI_API_KEY（检查 .env）');

  const only = process.env.EVAL_ONLY
    ? new Set(process.env.EVAL_ONLY.split(',').map((s) => s.trim()).filter(Boolean))
    : null;
  const cases = (dataset.items ?? []).filter(
    (it) => (!only || only.has(it.id)) && (it.expected_doc_titles ?? []).length > 0,
  );
  if (!cases.length) throw new Error('没有可用用例（需带 expected_doc_titles）');

  // 语料规模（写进报告，供核对）
  const total = await(await fetch(`${ES}/${CHUNK_INDEX}/_count`)).json();
  const docs = new Set();

  console.log(`\n单路召回消融  ES=${ES}  K=${K}  加权 BM25 权重=${W_BM25}`);
  console.log(`kh_chunk = ${total.count} 个切片　用例 = ${cases.length} 条\n`);

  const per = Object.fromEntries(ARMS.map((a) => [a, { metrics: [], took: [] }]));
  const rows = [];

  for (const item of cases) {
    const [vec, bm25Resp] = await Promise.all([embed(item.question), bm25(item.question)]);
    const knnResp = await knn(vec);
    const bm25Hits = toHits(bm25Resp);
    const knnHits = toHits(knnResp);
    bm25Hits.concat(knnHits).forEach((h) => docs.add(h.doc_title));

    const arms = {
      bm25_only: bm25Hits,
      knn_only: knnHits,
      dual_rrf: rrfFuse([knnHits, bm25Hits]),
      dual_weighted: weightedFuse([bm25Hits, knnHits], [W_BM25, 1 - W_BM25]),
    };

    const row = { id: item.id, q: item.question, expected: item.expected_doc_titles.join(' / ') };
    for (const a of ARMS) {
      const ordered = arms[a].slice(0, K);
      const titles = ordered.map((h) => h.doc_title);
      per[a].metrics.push(retrievalMetrics(item.expected_doc_titles, titles));
      per[a].took.push(a === 'knn_only' ? knnResp.took : bm25Resp.took);
      row[a] = { titles, top1: titles[0] ?? '（空）', first_hit_rank: titles.findIndex((t) => item.expected_doc_titles.includes(t)) + 1 || null };
    }
    rows.push(row);
    console.log(
      `${item.id}  首条命中位次  bm25=${row.bm25_only.first_hit_rank ?? '—'}` +
        `  knn=${row.knn_only.first_hit_rank ?? '—'}` +
        `  rrf=${row.dual_rrf.first_hit_rank ?? '—'}` +
        `  weighted=${row.dual_weighted.first_hit_rank ?? '—'}`,
    );
  }

  const summary = ARMS.map((a) => {
    const ms = per[a].metrics;
    return {
      arm: a,
      recall_at_k: mean(ms.map((m) => m.recall_at_k)),
      precision_at_k: mean(ms.map((m) => m.precision_at_k)),
      mrr: mean(ms.map((m) => m.mrr)),
      hit_at_k: mean(ms.map((m) => m.hit_at_k)),
      took_ms_mean: mean(per[a].took),
      n: ms.length,
    };
  });

  const L = [];
  L.push(`# 单路召回消融结果（K=${K}，用例 ${cases.length} 条，kh_chunk ${total.count} 切片）\n`);
  L.push('> **口径**：直连 ES（**不经后端、不含 rerank / 意图路由 / 切题评估 / 生成**）；');
  L.push('> ES DSL 与 RRF 实现逐行复制自生产代码（`vector-index.service.ts` / `rag-search.service.ts`）；');
  L.push('> 指标与 `rerank-ab.mjs` 完全一致（按 `doc_title` 精确匹配）；延迟为 ES `took`（纯检索耗时，不含网络与 embedding）。\n');
  L.push(`| 臂 | Recall@${K} | Precision@${K} | MRR | Hit@${K} | ES took 均值 ms |`);
  L.push('| :--- | :-: | :-: | :-: | :-: | :-: |');
  for (const s of summary) {
    L.push(`| ${s.arm} | ${fmt(s.recall_at_k)} | ${fmt(s.precision_at_k)} | ${fmt(s.mrr)} | ${fmt(s.hit_at_k)} | ${fmt(s.took_ms_mean, 1)} |`);
  }
  L.push('\n**逐用例首条命中位次**（— 表示 Top-5 全未命中）\n');
  L.push(`| 用例 | 期望文档 | 纯 BM25 | 纯 KNN | 双路 RRF | 加权求和 |`);
  L.push('| :--- | :--- | :-: | :-: | :-: | :-: |');
  for (const r of rows) {
    L.push(`| ${r.id} | ${r.expected} | ${r.bm25_only.first_hit_rank ?? '—'} | ${r.knn_only.first_hit_rank ?? '—'} | ${r.dual_rrf.first_hit_rank ?? '—'} | ${r.dual_weighted.first_hit_rank ?? '—'} |`);
  }
  L.push('\n**逐用例 Top-1**\n');
  L.push('| 用例 | 纯 BM25 | 纯 KNN | 双路 RRF |');
  L.push('| :--- | :--- | :--- | :--- |');
  for (const r of rows) {
    L.push(`| ${r.id} | ${r.bm25_only.top1} | ${r.knn_only.top1} | ${r.dual_rrf.top1} |`);
  }
  const out = L.join('\n');
  console.log('\n' + out + '\n');

  // 只在「少报一个不存在的事实」这件事上额外校验：统计两路都漏的用例
  const bothMiss = rows.filter((r) => !r.bm25_only.first_hit_rank && !r.knn_only.first_hit_rank);
  const rrfSaved = bothMiss.filter((r) => r.dual_rrf.first_hit_rank);
  console.log(`两路都漏的用例：${bothMiss.length} 条` + (bothMiss.length ? `（${bothMiss.map((r) => r.id).join(', ')}）` : ''));
  console.log(`其中被 RRF 融合救回的：${rrfSaved.length} 条` + (rrfSaved.length ? `（${rrfSaved.map((r) => r.id).join(', ')}）` : ''));
  const knnMiss = rows.filter((r) => !r.knn_only.first_hit_rank && r.bm25_only.first_hit_rank);
  console.log(`纯 KNN 漏、纯 BM25 命中的用例：${knnMiss.length} 条` + (knnMiss.length ? `（${knnMiss.map((r) => r.id).join(', ')}）` : ''));
  const bm25Miss = rows.filter((r) => !r.bm25_only.first_hit_rank && r.knn_only.first_hit_rank);
  console.log(`纯 BM25 漏、纯 KNN 命中的用例：${bm25Miss.length} 条` + (bm25Miss.length ? `（${bm25Miss.map((r) => r.id).join(', ')}）` : ''));

  if (process.env.RECALL_AB_OUT) {
    writeFileSync(process.env.RECALL_AB_OUT, out, 'utf8');
    console.log(`\n已写入 ${process.env.RECALL_AB_OUT}`);
  }
}

main().catch((err) => {
  console.error(`运行失败：${msg(err)}`);
  process.exit(1);
});
