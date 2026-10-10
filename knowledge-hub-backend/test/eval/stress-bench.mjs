#!/usr/bin/env node
/**
 * 检索接口压力测试（补「方案对比卡」DECOMPOSE 空白：把端到端延迟归因到具体瓶颈）
 *
 * 测什么：
 *   1. 主目标 `GET /rag/search`（生产配置 hybrid + rerank=on）的并发阶梯压测
 *   2. 对照目标 `GET /search`（纯 ES 全文检索，**无任何外部模型调用**）
 *      —— 用来把「本地栈的吞吐上限」和「外部模型 API 的吞吐上限」分开
 *
 * 口径说明（写进结论时必须带上）：
 *   - 每个并发档位发固定请求数（默认 60），保证各档样本量一致，便于比较 P95/P99
 *   - 延迟为客户端的端到端 wall time（含 TCP/HTTP、鉴权、服务端处理）
 *   - 客户端与后端同机，所以这是**单机上限**，不等于生产容量；数值只能作相对比较
 *   - 请求的瓶颈包含 DashScope 的**公网往返 + 服务端限流**，因此错误里若出现 429/超时，
 *     要归因到外部模型服务，而不是本服务
 *
 * 用法：
 *   node test/eval/stress-bench.mjs
 * 可选环境变量：
 *   EVAL_BASE_URL   默认 http://localhost:3000
 *   STRESS_LEVELS   默认 "1,2,4,8,16,32"
 *   STRESS_N        每档请求数，默认 60
 *   STRESS_OUT      结果 markdown 落盘路径（默认 test/eval/results/stress-report.md）
 */

import 'dotenv/config';
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const BASE = process.env.EVAL_BASE_URL ?? 'http://localhost:3000';
const USERNAME = process.env.EVAL_USERNAME ?? 'admin';
const PASSWORD = process.env.EVAL_PASSWORD ?? '123456';
const LEVELS = (process.env.STRESS_LEVELS ?? '1,2,4,8,16,32').split(',').map((s) => Number(s.trim())).filter(Boolean);
const N_PER_LEVEL = Number(process.env.STRESS_N ?? 60);
const HERE = dirname(fileURLToPath(import.meta.url));
const RESULTS_DIR = join(HERE, 'results');

/** 固定查询池：控制查询内容带来的方差（8 条，覆盖真实语料与合成语料主题） */
const QUERY_POOL = [
  '加班餐补的标准和上限是多少？',
  '法定节假日加班的工资怎么计算？',
  '新员工第一周需要完成哪些事情？',
  '公司的文档密级分为哪几级？',
  '项目立项预算超过 50 万需要谁审批？',
  'DC06 的均热段保温温度和机组速度分别是多少？',
  '冲压时总是裂开，是不是材料太硬了？',
  '连铸结晶器保护渣的作业要点是什么？',
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

const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const percentile = (xs, p) => {
  if (!xs.length) return 0;
  const sorted = [...xs].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[idx];
};
const fmt = (v, d = 1) => (v === null || v === undefined ? '—' : Number(v).toFixed(d));

/**
 * 并发阶梯：concurrency 个 worker 共享一个计数器，直到发满 total 个请求。
 * 返回每条请求的 { ms, ok, status, error }。
 */
async function runLevel(token, label, buildUrl, concurrency, total) {
  let issued = 0;
  const results = [];
  const t0 = Date.now();

  async function worker() {
    for (;;) {
      const i = issued++;
      if (i >= total) return;
      const q = QUERY_POOL[i % QUERY_POOL.length];
      const started = Date.now();
      try {
        const res = await fetch(buildUrl(q), {
          headers: { Authorization: `Bearer ${token}` },
          signal: AbortSignal.timeout(60_000),
        });
        const body = await res.text();
        results.push({ ms: Date.now() - started, ok: res.ok, status: res.status, error: res.ok ? null : body.slice(0, 160) });
      } catch (err) {
        results.push({ ms: Date.now() - started, ok: false, status: 0, error: msg(err).slice(0, 160) });
      }
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  const wall = Date.now() - t0;

  const lat = results.map((r) => r.ms);
  const okLat = results.filter((r) => r.ok).map((r) => r.ms);
  const failed = results.filter((r) => !r.ok);
  const errKinds = {};
  for (const f of failed) {
    const key = f.status ? `HTTP ${f.status}` : /timeout|abort/i.test(f.error ?? '') ? 'timeout' : 'other';
    errKinds[key] = (errKinds[key] ?? 0) + 1;
  }

  const row = {
    label,
    concurrency,
    total: results.length,
    wall_ms: wall,
    rps: results.length / (wall / 1000),
    ok: results.length - failed.length,
    failed: failed.length,
    errorRate: results.length ? failed.length / results.length : 0,
    errKinds,
    mean: mean(lat),
    p50: percentile(lat, 50),
    p95: percentile(lat, 95),
    p99: percentile(lat, 99),
    max: lat.length ? Math.max(...lat) : 0,
    okMean: mean(okLat),
  };
  return row;
}

async function main() {
  mkdirSync(RESULTS_DIR, { recursive: true });
  const token = await login();
  console.log(`\n压测目标 ${BASE}\n档位 ${LEVELS.join('/')} 并发，每档 ${N_PER_LEVEL} 请求\n`);

  const ragUrl = (q) => `${BASE}/rag/search?q=${encodeURIComponent(q)}&top_k=5&rerank=true&mode=hybrid`;
  const searchUrl = (q) => `${BASE}/search?q=${encodeURIComponent(q)}&pageSize=10`;

  const ragRows = [];
  const searchRows = [];

  console.log('── 主目标 GET /rag/search（含查询向量化 + 双路召回 + RRF + 精排）──');
  for (const c of LEVELS) {
    const row = await runLevel(token, 'rag-search', ragUrl, c, N_PER_LEVEL);
    ragRows.push(row);
    console.log(
      `并发 ${String(c).padStart(3)}  吞吐 ${fmt(row.rps, 2)} req/s  P50 ${fmt(row.p50)}  P95 ${fmt(row.p95)}  P99 ${fmt(row.p99)}  ` +
        `失败 ${row.failed}/${row.total}${row.failed ? `（${JSON.stringify(row.errKinds)}）` : ''}`,
    );
  }

  console.log('\n── 对照目标 GET /search（纯 ES 全文检索，无外部模型调用）──');
  for (const c of LEVELS) {
    const row = await runLevel(token, 'search', searchUrl, c, N_PER_LEVEL);
    searchRows.push(row);
    console.log(
      `并发 ${String(c).padStart(3)}  吞吐 ${fmt(row.rps, 2)} req/s  P50 ${fmt(row.p50)}  P95 ${fmt(row.p95)}  P99 ${fmt(row.p99)}  ` +
        `失败 ${row.failed}/${row.total}${row.failed ? `（${JSON.stringify(row.errKinds)}）` : ''}`,
    );
  }

  const lines = [];
  lines.push('# 检索接口压力测试报告');
  lines.push('');
  lines.push('## 测试方法');
  lines.push('');
  lines.push('- 客户端：Node 20+ 原生 `fetch`，固定并发 worker 池；客户端与后端**同机**（因此是单机上限，非生产容量）');
  lines.push(`- 压测档位：并发 ${LEVELS.join(' / ')}，每档固定发 ${N_PER_LEVEL} 个请求（各档样本量一致，便于比较分位数）`);
  lines.push(`- 查询池：8 条固定查询循环复用，避免查询内容差异污染方差`);
  lines.push('- 延迟口径：客户端端到端 wall time（含 TCP/HTTP、JWT 鉴权、服务端处理），非服务端自报耗时');
  lines.push('- 错误口径：HTTP 非 2xx 或抛异常均计为失败，并按 HTTP 状态码分类统计');
  lines.push('- 环境：本机 Docker 单节点 ES（`-Xms512m -Xmx512m`）、`LANGFUSE_ENABLED=false`');
  lines.push('');
  lines.push('## 主目标 `GET /rag/search`（生产配置：hybrid + rerank=on）');
  lines.push('');
  lines.push('| 并发 | 吞吐 req/s | 成功/总数 | 失败率 | 均值 ms | P50 ms | P95 ms | P99 ms | 最大 ms | 失败类型 |');
  lines.push('| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | :--- |');
  for (const r of ragRows) {
    lines.push(
      `| ${r.concurrency} | ${fmt(r.rps, 2)} | ${r.ok}/${r.total} | ${(r.errorRate * 100).toFixed(1)}% | ${fmt(r.mean)} | ` +
        `${fmt(r.p50)} | ${fmt(r.p95)} | ${fmt(r.p99)} | ${fmt(r.max)} | ${r.failed ? JSON.stringify(r.errKinds) : '—'} |`,
    );
  }
  lines.push('');
  lines.push('## 对照目标 `GET /search`（纯 ES 全文检索，作为本地栈吞吐上限）');
  lines.push('');
  lines.push('| 并发 | 吞吐 req/s | 成功/总数 | 失败率 | 均值 ms | P50 ms | P95 ms | P99 ms | 最大 ms | 失败类型 |');
  lines.push('| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | :--- |');
  for (const r of searchRows) {
    lines.push(
      `| ${r.concurrency} | ${fmt(r.rps, 2)} | ${r.ok}/${r.total} | ${(r.errorRate * 100).toFixed(1)}% | ${fmt(r.mean)} | ` +
        `${fmt(r.p50)} | ${fmt(r.p95)} | ${fmt(r.p99)} | ${fmt(r.max)} | ${r.failed ? JSON.stringify(r.errKinds) : '—'} |`,
    );
  }
  lines.push('');
  lines.push('## 吞吐对比');
  lines.push('');
  lines.push('| 并发 | rag-search req/s | search req/s | 倍数 |');
  lines.push('| ---: | ---: | ---: | ---: |');
  for (let i = 0; i < LEVELS.length; i++) {
    const a = ragRows[i]?.rps ?? 0;
    const b = searchRows[i]?.rps ?? 0;
    lines.push(`| ${LEVELS[i]} | ${fmt(a, 2)} | ${fmt(b, 2)} | ${b > 0 ? fmt(b / a, 1) : '—'}× |`);
  }
  lines.push('');

  const md = lines.join('\n');
  const out = process.env.STRESS_OUT ?? join(RESULTS_DIR, 'stress-report.md');
  writeFileSync(out, md, 'utf8');
  writeFileSync(
    join(RESULTS_DIR, 'stress-report.json'),
    JSON.stringify({ generatedAt: new Date().toISOString(), levels: LEVELS, nPerLevel: N_PER_LEVEL, ragRows, searchRows }, null, 2),
    'utf8',
  );
  console.log('\n' + md);
  console.log(`已写入 ${out}`);
}

main().catch((err) => {
  console.error(`运行失败：${msg(err)}`);
  process.exit(1);
});
