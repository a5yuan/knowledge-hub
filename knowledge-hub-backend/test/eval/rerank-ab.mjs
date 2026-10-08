#!/usr/bin/env node
/**
 * Rerank A/B 对照 —— 补「方案对比卡 · 卡 2」的证据缺口
 *
 * 为什么需要它：工单 13 的 run-eval.mjs 算的是**全链路**指标（Agent 路径的
 * data-retrieve 结果 + LLM judge），**不是 rerank 开/关的隔离对比**。
 * 而 `rerank` 恰好是 GET /rag/search 的查询参数，所以做 A/B 不需要改被测代码
 * —— 这也正是本脚本的全部价值：把「Rerank 到底值多少」从定性说法变成数字。
 *
 * 与 run-eval.mjs 的差异：
 *   - 走 GET /rag/search（直连检索层），不走 Agent SSE → 排除意图路由/切题评估/生成的干扰
 *   - 按**标题**匹配 ground truth（/rag/search 返回 doc_title），故不依赖 corpus-manifest.json
 *   - 不调用 LLM judge（只测检索层，judge 指标与此无关）
 *
 * 用法：node test/eval/rerank-ab.mjs
 * 可选环境变量：
 *   EVAL_BASE_URL   默认 http://localhost:3000
 *   EVAL_ONLY       逗号分隔用例 id，如 qa-001,qa-013
 *   RERANK_AB_OUT   输出 markdown 的路径（默认只打印，不落盘）
 *
 * 前置：后端已启动；dataset.json 里的语料已上传并发布（否则召回全 0）。
 */

import 'dotenv/config';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const BASE = process.env.EVAL_BASE_URL ?? 'http://localhost:3000';
const USERNAME = process.env.EVAL_USERNAME ?? 'admin';
const PASSWORD = process.env.EVAL_PASSWORD ?? '123456';
const HERE = dirname(fileURLToPath(import.meta.url));

const dataset = JSON.parse(readFileSync(join(HERE, 'dataset.json'), 'utf8'));
const K = dataset.k ?? 5;

/** 两个待对照的臂：rerank 开 / 关 */
const ARMS = [
  { key: 'rerank_on', label: 'rerank=true（实际方案）', rerank: true },
  { key: 'rerank_off', label: 'rerank=false（baseline：仅 RRF）', rerank: false },
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

/**
 * 单次检索。返回 { titles, tookMs } —— titles 按返回顺序（已由服务端排好序）。
 * 走真实通道需带 Bearer；/rag/search 无全局前缀。
 */
async function searchOnce(token, q, rerank) {
  const url = `${BASE}/rag/search?q=${encodeURIComponent(q)}&top_k=${K}&rerank=${rerank}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) {
    const body = (await res.text()).slice(0, 200);
    throw new Error(`/rag/search ${res.status}: ${body}`);
  }
  const data = await res.json();
  const items = Array.isArray(data.items) ? data.items : [];
  return { titles: items.map((it) => it.doc_title), tookMs: data.took_ms ?? null };
}

/**
 * 与 run-eval.mjs 的 retrievalMetrics 同算法，但匹配键从 documentId 换成 doc_title
 * （/rag/search 不返回 documentId，标题已是数据集里的 ground truth 口径）。
 */
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
    /** 首条命中位置，便于人工看「精排把对的那条提到了第几位」 */
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

async function main() {
  const only = process.env.EVAL_ONLY
    ? new Set(process.env.EVAL_ONLY.split(',').map((s) => s.trim()).filter(Boolean))
    : null;

  const cases = (dataset.items ?? []).filter(
    (it) => (!only || only.has(it.id)) && (it.expected_doc_titles ?? []).length > 0,
  );
  if (!cases.length) {
    console.error('没有可用用例（需带 expected_doc_titles）');
    process.exit(1);
  }
  const skipped = (dataset.items ?? []).length - cases.length;

  console.log(`\nRerank A/B 对照  base=${BASE}  K=${K}`);
  console.log(`用例数=${cases.length}${skipped > 0 ? `（另有 ${skipped} 条无 ground truth，已跳过）` : ''}\n`);

  const token = await login();
  /** perArm[armKey] = { metrics: [], latencies: [] } */
  const perArm = Object.fromEntries(ARMS.map((a) => [a.key, { metrics: [], latencies: [] }]));
  const rows = [];

  for (const item of cases) {
    const row = { id: item.id, q: item.question, expected: item.expected_doc_titles.join(' / ') };
    for (const arm of ARMS) {
      try {
        const { titles, tookMs } = await searchOnce(token, item.question, arm.rerank);
        const m = retrievalMetrics(item.expected_doc_titles, titles);
        perArm[arm.key].metrics.push(m);
        if (tookMs !== null) perArm[arm.key].latencies.push(tookMs);
        row[arm.key] = { ...m, tookMs, top1: titles[0] ?? '（空）' };
      } catch (err) {
        row[arm.key] = { error: msg(err) };
      }
    }
    rows.push(row);
    const on = row.rerank_on.first_hit_rank ?? '—';
    const off = row.rerank_off.first_hit_rank ?? '—';
    console.log(
      `${item.id}  首条命中位次 rerank_on=${on} rerank_off=${off}` +
        (row.rerank_on.error ? `  ⚠️ ${row.rerank_on.error}` : ''),
    );
  }

  // ── 汇总 ──
  const summary = ARMS.map((arm) => {
    const ms = perArm[arm.key].metrics;
    const ls = perArm[arm.key].latencies;
    return {
      arm: arm.label,
      recall_at_k: mean(ms.map((m) => m.recall_at_k)),
      precision_at_k: mean(ms.map((m) => m.precision_at_k)),
      mrr: mean(ms.map((m) => m.mrr)),
      hit_at_k: mean(ms.map((m) => m.hit_at_k)),
      took_ms_mean: mean(ls),
      took_ms_p95: percentile(ls, 95),
      n: ms.length,
    };
  });

  const delta = (a, b) => (b === 0 ? (a === 0 ? 0 : Infinity) : (a - b) / b);

  const lines = [];
  lines.push(`# Rerank A/B 结果（K=${K}，用例 ${cases.length} 条）\n`);
  lines.push('> 口径：直连 `GET /rag/search`（不含意图路由/切题评估/生成的干扰）；');
  lines.push('> ground truth = `dataset.json` 的 `expected_doc_titles`，按标题精确匹配；');
  lines.push('> 延迟 `took_ms` 是**整条检索链路**耗时，非纯重排耗时。\n');
  lines.push('| 方案 | Recall@' + K + ' | Precision@' + K + ' | MRR | Hit@' + K + ' | 延迟均值 ms | 延迟 P95 ms |');
  lines.push('| :--- | :-: | :-: | :-: | :-: | :-: | :-: |');
  for (const s of summary) {
    lines.push(
      `| ${s.arm} | ${fmt(s.recall_at_k)} | ${fmt(s.precision_at_k)} | ${fmt(s.mrr)} | ${fmt(s.hit_at_k)} | ${fmt(s.took_ms_mean, 1)} | ${fmt(s.took_ms_p95, 1)} |`,
    );
  }
  const [on, off] = summary;
  lines.push('\n**增量（rerank_on 相对 rerank_off）**\n');
  lines.push(
    `- Recall@${K}：${fmt(delta(on.recall_at_k, off.recall_at_k) * 100, 1)}%　` +
      `MRR：${fmt(delta(on.mrr, off.mrr) * 100, 1)}%　` +
      `延迟：+${fmt(on.took_ms_mean - off.took_ms_mean, 1)} ms（均值）`,
  );
  lines.push('\n| 用例 | 期望文档 | rerank_on 首条命中 | rerank_off 首条命中 |');
  lines.push('| :--- | :--- | :-: | :-: |');
  for (const r of rows) {
    lines.push(
      `| ${r.id} | ${r.expected} | ${r.rerank_on.first_hit_rank ?? '—'} | ${r.rerank_off.first_hit_rank ?? '—'} |`,
    );
  }
  const out = lines.join('\n');
  console.log('\n' + out + '\n');

  if (process.env.RERANK_AB_OUT) {
    writeFileSync(process.env.RERANK_AB_OUT, out, 'utf8');
    console.log(`已写入 ${process.env.RERANK_AB_OUT}`);
  }
}

main().catch((err) => {
  console.error(`运行失败：${msg(err)}`);
  process.exit(1);
});