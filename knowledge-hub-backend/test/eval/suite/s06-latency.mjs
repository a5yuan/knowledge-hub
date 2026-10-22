#!/usr/bin/env node
/**
 * s06 · 检索延迟分位（工单 24 指标 #6）
 *
 * **复用既有压测报告，不重跑**。理由：
 * - `stress-bench.mjs` 一轮要发 6 档 × 60 = 360 个请求，每个都走 DashScope rerank，
 *   既烧额度又可能触发 429，把「延迟」测成「限流表现」
 * - `scale-bench.mjs` 会往 ES 写 1186 个合成 chunk（有 --cleanup），跑完会污染演示库
 *
 * 数据来源：`results/stress-report.md`（并发阶梯）+ `results/scale-curve.md`（语料规模曲线）。
 * 两份报告的采集日期会写进结果，**旧数据必须带日期**，否则读者会以为是当期数字。
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { resolveSuiteDir, writeItemJson, EVAL_ROOT } from '../lib/report.mjs';

const STRESS = join(EVAL_ROOT, 'results', 'stress-report.md');
const SCALE = join(EVAL_ROOT, 'results', 'scale-curve.md');

/** 从 markdown 表格行里抽数值：| 1 | 2.99 | 60/60 | 0.0% | 334.6 | 315.0 | 463.0 | 703.0 | ... */
function parseConcurrencyRows(md) {
  const rows = [];
  const re = /^\|\s*(\d+)\s*\|\s*([\d.]+)\s*\|\s*(\d+\/\d+)\s*\|\s*([\d.]+)%\s*\|\s*([\d.]+)\s*\|\s*([\d.]+)\s*\|\s*([\d.]+)\s*\|\s*([\d.]+)\s*\|/gm;
  let m;
  while ((m = re.exec(md)) !== null) {
    rows.push({
      concurrency: Number(m[1]),
      throughput_rps: Number(m[2]),
      ok_total: m[3],
      fail_rate: Number(m[4]),
      avg_ms: Number(m[5]),
      p50_ms: Number(m[6]),
      p95_ms: Number(m[7]),
      p99_ms: Number(m[8]),
    });
  }
  return rows;
}

/** 抽报告里的采集日期（形如 `- 生成时间：2026-10-10 ...` 或文件名时间） */
function parseDate(md) {
  const m = md.match(/(20\d{2}-\d{2}-\d{2})/);
  return m ? m[1] : null;
}

/**
 * 只取「主目标」章节的表格。
 *
 * `stress-report.md` 里有两张结构相同的表：
 *   主目标 `GET /rag/search`（生产配置 hybrid + rerank）—— 这才是"检索延迟"
 *   对照目标 `GET /search`（纯 ES，无模型调用）—— 吞吐高一个量级，混进来会把结论带偏
 * 初版没做切分，导致 index.md 把对照组的 163 req/s 当成主目标峰值吞吐。
 */
function mainTargetSection(md) {
  const start = md.indexOf('## 主目标');
  if (start < 0) return md;
  const next = md.indexOf('\n## ', start + 5);
  return next < 0 ? md.slice(start) : md.slice(start, next);
}

function main() {
  const suiteDir = resolveSuiteDir();
  console.log('s06 · 检索延迟分位（复用既有压测报告）');

  if (!existsSync(STRESS)) {
    console.log('  ❌ 缺少 results/stress-report.md');
    writeItemJson(suiteDir, 's06-latency', {
      status: 'skip',
      reason: 'stress-report.md 不存在',
    });
    process.exitCode = 2;
    return;
  }

  const stressMd = readFileSync(STRESS, 'utf8');
  const section = mainTargetSection(stressMd);
  const rows = parseConcurrencyRows(section);
  const collectedAt = parseDate(stressMd);

  if (!rows.length) {
    console.log('  ❌ 未能从 stress-report.md 解析出并发阶梯表');
    writeItemJson(suiteDir, 's06-latency', {
      status: 'skip',
      reason: '解析失败：表格格式与预期不符',
    });
    process.exitCode = 2;
    return;
  }

  const one = rows.find((r) => r.concurrency === 1) ?? rows[0];
  const best = rows.reduce((a, b) => (b.throughput_rps > a.throughput_rps ? b : a), rows[0]);
  const allOk = rows.every((r) => r.fail_rate === 0);

  // 规模曲线（可选，能解析到就带上）
  let scaleSummary = null;
  if (existsSync(SCALE)) {
    const scaleMd = readFileSync(SCALE, 'utf8');
    scaleSummary = {
      report: 'results/scale-curve.md',
      collectedAt: parseDate(scaleMd),
      note: '34 → 1186 chunk 六档语料规模下的端到端延迟曲线',
    };
  }

  const payload = {
    id: 's06',
    name: '检索延迟分位',
    status: allOk ? 'pass' : 'fail',
    metric: `单并发 P50=${one.p50_ms}ms P95=${one.p95_ms}ms；峰值吞吐 ${best.throughput_rps} req/s @ 并发 ${best.concurrency}`,
    target: '记录型指标（无硬目标），关注退化与失败率',
    conclusion: allOk
      ? `单并发 P95=${one.p95_ms}ms；并发 ${best.concurrency} 时吞吐达 ${best.throughput_rps} req/s 且零失败。并发 ≥8 后 P95 升至 ${rows.find((r) => r.concurrency === 8)?.p95_ms ?? '—'}ms，瓶颈在 DashScope 公网调用`
      : '存在失败请求，详见 stress-report.md',
    source: {
      report: 'results/stress-report.md',
      collectedAt,
      scaleCurve: scaleSummary,
    },
    concurrency_table: rows,
    caveats: [
      `数据采集于 ${collectedAt ?? '未知日期'}，不是本次运行时的当期数字；此后检索链路（rag / es / rerank）代码未变更，故仍具代表性`,
      '本节**只取主目标** `GET /rag/search`（hybrid + rerank）。原报告另有一张「对照目标 `GET /search`（纯 ES、无模型调用）」的表，其吞吐高一个量级，两者不可混用',
      '客户端与后端同机，是**单机上限**，不等于生产容量；数值只可作相对比较',
      '瓶颈含 DashScope 公网往返，出现 429/超时应归因到外部模型服务而非本服务',
      '压测用 4 篇短文档（24 chunk）的演示语料，规模效应见 scale-curve.md',
    ],
  };
  writeItemJson(suiteDir, 's06-latency', payload);

  console.log(`  单并发 P50=${one.p50_ms}ms  P95=${one.p95_ms}ms  P99=${one.p99_ms}ms`);
  console.log(`  峰值吞吐 ${best.throughput_rps} req/s @ 并发 ${best.concurrency}`);
  console.log(`  采集日期 ${collectedAt ?? '未知'}`);
  console.log(`  ${allOk ? '✅ 通过（零失败）' : '❌ 存在失败请求'}`);
  console.log(`  明细：${join(suiteDir, 's06-latency.json')}`);
  if (!allOk) process.exitCode = 1;
}

main();
