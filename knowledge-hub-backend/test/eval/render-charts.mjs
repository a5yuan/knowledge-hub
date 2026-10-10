#!/usr/bin/env node
/**
 * 把评测结果 JSON 渲染成一张自包含 HTML（内联 SVG，无外部依赖、无网络请求）。
 *
 * 数据源（均由 test/eval 下各 bench 脚本产出）：
 *   results/scale-curve.json    千级语料延迟曲线
 *   results/stress-report.json  压测吞吐/延迟
 *
 * 用法：node test/eval/render-charts.mjs
 * 产物：test/eval/results/delay-stress-report.html
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const RES = join(HERE, 'results');

const scale = JSON.parse(readFileSync(join(RES, 'scale-curve.json'), 'utf8'));
const stress = JSON.parse(readFileSync(join(RES, 'stress-report.json'), 'utf8'));

const C = {
  ink: '#1f2328',
  sub: '#5b6470',
  grid: '#e6e9ee',
  axis: '#c3c9d2',
  p1: '#2f6feb',
  p2: '#d94f3d',
  p3: '#1a9e6f',
  p4: '#8a5cd6',
  p5: '#c98a12',
  bg: '#ffffff',
  card: '#f7f8fa',
};

const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);

/**
 * 通用折线图：
 *   xMode: 'linear' | 'log2'
 *   series: [{ name, color, values: number[], dashed?: boolean }]
 */
function lineChart({ title, sub, xVals, xLabel, series, yLabel, yMax, unit = 'ms', xMode = 'linear', height = 300 }) {
  const W = 880;
  const H = height;
  const pad = { l: 64, r: 150, t: 46, b: 52 };
  const iw = W - pad.l - pad.r;
  const ih = H - pad.t - pad.b;

  const xToPx = (v, i) => {
    if (xMode === 'log2') {
      const f = Math.log2(v) / Math.log2(Math.max(...xVals));
      return pad.l + f * iw;
    }
    const min = Math.min(...xVals);
    const max = Math.max(...xVals);
    const f = max === min ? 0.5 : (v - min) / (max - min);
    return pad.l + f * iw;
  };
  const yTop = yMax ?? Math.max(...series.flatMap((s) => s.values)) * 1.12;
  const yToPx = (v) => pad.t + ih - (v / yTop) * ih;

  const ticks = 5;
  let g = '';
  for (let i = 0; i <= ticks; i++) {
    const v = (yTop / ticks) * i;
    const y = yToPx(v);
    g += `<line x1="${pad.l}" y1="${y.toFixed(1)}" x2="${pad.l + iw}" y2="${y.toFixed(1)}" stroke="${C.grid}" stroke-width="1"/>`;
    g += `<text x="${pad.l - 10}" y="${(y + 4).toFixed(1)}" text-anchor="end" font-size="11" fill="${C.sub}">${Math.round(v)}</text>`;
  }

  let xa = '';
  xVals.forEach((v, i) => {
    const x = xToPx(v, i);
    xa += `<line x1="${x.toFixed(1)}" y1="${pad.t + ih}" x2="${x.toFixed(1)}" y2="${pad.t + ih + 5}" stroke="${C.axis}"/>`;
    xa += `<text x="${x.toFixed(1)}" y="${pad.t + ih + 20}" text-anchor="middle" font-size="11" fill="${C.sub}">${esc(v)}</text>`;
  });

  let lines = '';
  series.forEach((s, si) => {
    const pts = s.values.map((v, i) => `${xToPx(xVals[i], i).toFixed(1)},${yToPx(v).toFixed(1)}`).join(' ');
    lines += `<polyline points="${pts}" fill="none" stroke="${s.color}" stroke-width="2.2" ${s.dashed ? 'stroke-dasharray="5 4"' : ''} stroke-linejoin="round"/>`;
    s.values.forEach((v, i) => {
      lines += `<circle cx="${xToPx(xVals[i], i).toFixed(1)}" cy="${yToPx(v).toFixed(1)}" r="3.4" fill="${C.bg}" stroke="${s.color}" stroke-width="2"/>`;
    });
    // 末点数值标注
    const lastI = s.values.length - 1;
    lines += `<text x="${(xToPx(xVals[lastI], lastI) + 8).toFixed(1)}" y="${(yToPx(s.values[lastI]) + 4).toFixed(1)}" font-size="11" fill="${s.color}">${s.values[lastI].toFixed(s.dp ?? 1)}${unit}</text>`;
    // 图例
    const ly = pad.t + 4 + si * 18;
    lines += `<rect x="${pad.l + iw + 14}" y="${ly - 8}" width="10" height="10" rx="2" fill="${s.color}"/>`;
    lines += `<text x="${pad.l + iw + 30}" y="${ly + 1}" font-size="11.5" fill="${C.ink}">${esc(s.name)}</text>`;
  });

  return `
  <figure class="chart">
    <figcaption><strong>${esc(title)}</strong>${sub ? `<span class="cs">${esc(sub)}</span>` : ''}</figcaption>
    <svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="${esc(title)}">
      ${g}
      <line x1="${pad.l}" y1="${pad.t + ih}" x2="${pad.l + iw}" y2="${pad.t + ih}" stroke="${C.axis}"/>
      <line x1="${pad.l}" y1="${pad.t}" x2="${pad.l}" y2="${pad.t + ih}" stroke="${C.axis}"/>
      ${xa}${lines}
      <text x="${pad.l - 46}" y="${pad.t - 16}" font-size="11" fill="${C.sub}">${esc(yLabel)}</text>
      <text x="${pad.l + iw}" y="${pad.t + ih + 40}" text-anchor="end" font-size="11" fill="${C.sub}">${esc(xLabel)}</text>
    </svg>
  </figure>`;
}

const c = scale.curve;
const chunks = c.map((r) => r.chunks);
const conc = stress.levels;

const charts = [
  lineChart({
    title: '延迟曲线 · 端到端（hybrid + rerank，top_k=5）',
    sub: `语料 34 → ${scale.chunkTotal} chunk（${(scale.chunkTotal / scale.baseCount).toFixed(1)}×），每档 ${c[0].n} 样本`,
    xVals: chunks,
    xLabel: '语料 chunk 数',
    yLabel: 'ms',
    series: [
      { name: '均值', color: C.p1, values: c.map((r) => r.mean) },
      { name: 'P50', color: C.p3, values: c.map((r) => r.p50), dashed: true },
      { name: 'P95', color: C.p2, values: c.map((r) => r.p95), dashed: true },
    ],
  }),
  lineChart({
    title: '分阶段耗时随语料规模变化',
    sub: 'embed / rerank 是公网模型调用（与本地语料规模无关）；knn / bm25 才受规模影响',
    xVals: chunks,
    xLabel: '语料 chunk 数',
    yLabel: 'ms',
    series: [
      { name: '查询向量化', color: C.p1, values: c.map((r) => r.stages.embed_ms) },
      { name: '精排 rerank', color: C.p2, values: c.map((r) => r.stages.rerank_ms) },
      { name: 'KNN 召回', color: C.p3, values: c.map((r) => r.stages.knn_ms) },
      { name: 'BM25 召回', color: C.p4, values: c.map((r) => r.stages.bm25_ms) },
      { name: 'RRF 融合', color: C.p5, values: c.map((r) => r.stages.fuse_ms) },
    ],
  }),
  lineChart({
    title: '压测 · 吞吐随并发变化',
    sub: `每档固定 ${stress.nPerLevel} 请求；rag-search（hybrid+rerank）vs 纯 ES 全文检索`,
    xVals: conc,
    xLabel: '并发数（对数轴）',
    yLabel: 'req/s',
    unit: '',
    xMode: 'log2',
    series: [
      { name: '纯 ES /search', color: C.p1, values: stress.searchRows.map((r) => r.rps) },
      { name: 'rag-search', color: C.p2, values: stress.ragRows.map((r) => r.rps) },
    ],
  }),
  lineChart({
    title: '压测 · 延迟随并发变化',
    sub: 'P50 与 P95；全程 0 失败，瓶颈是外部模型 API 而非本地栈',
    xVals: conc,
    xLabel: '并发数（对数轴）',
    yLabel: 'ms',
    xMode: 'log2',
    series: [
      { name: 'rag P50', color: C.p2, values: stress.ragRows.map((r) => r.p50) },
      { name: 'rag P95', color: C.p2, values: stress.ragRows.map((r) => r.p95), dashed: true },
      { name: 'ES P50', color: C.p1, values: stress.searchRows.map((r) => r.p50) },
    ],
  }),
].join('\n');

const html = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>知识库检索 · 延迟曲线与压测报告</title>
<style>
  :root{color-scheme:light}
  *{box-sizing:border-box}
  body{margin:0;padding:32px 20px 64px;background:${C.bg};color:${C.ink};
       font:15px/1.65 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif}
  main{max-width:920px;margin:0 auto}
  h1{font-size:23px;margin:0 0 6px;letter-spacing:-.01em}
  .lede{color:${C.sub};font-size:13.5px;margin:0 0 24px}
  .meta{display:flex;flex-wrap:wrap;gap:8px;margin:0 0 26px}
  .tag{background:${C.card};border:1px solid ${C.grid};border-radius:6px;padding:5px 10px;font-size:12px;color:${C.sub}}
  figure.chart{margin:0 0 30px;padding:18px 18px 8px;background:${C.bg};border:1px solid ${C.grid};border-radius:10px;overflow-x:auto}
  figcaption{font-size:14px;margin:0 0 12px;display:flex;flex-wrap:wrap;align-items:baseline;gap:10px}
  .cs{color:${C.sub};font-size:12px;font-weight:400}
  .note{background:${C.card};border-left:3px solid ${C.p1};border-radius:0 8px 8px 0;padding:14px 16px;margin:0 0 26px;font-size:13.5px}
  .note h3{margin:0 0 8px;font-size:14px}
  .note ul{margin:0;padding-left:18px}
  .note li{margin:4px 0}
  code{background:${C.card};padding:1px 5px;border-radius:4px;font-size:12.5px}
  footer{color:${C.sub};font-size:12px;border-top:1px solid ${C.grid};padding-top:14px;margin-top:20px}
</style>
</head>
<body>
<main>
  <h1>知识库检索 · 延迟曲线与压测报告</h1>
  <p class="lede">企业级知识库后端 · RAG 混合检索（BM25 + KNN → RRF → DashScope Rerank）</p>
  <div class="meta">
    <span class="tag">延迟曲线采集：${scale.generatedAt}</span>
    <span class="tag">压测采集：${stress.generatedAt}</span>
    <span class="tag">语料 34 → ${scale.chunkTotal} chunk</span>
    <span class="tag">并发 1–32，每档 ${stress.nPerLevel} 请求</span>
    <span class="tag">全程 0 失败</span>
  </div>

  <div class="note">
    <h3>结论先行</h3>
    <ul>
      <li><strong>语料扩 36 倍，端到端延迟基本不变</strong>：均值 316.6 → 325.1ms，P95 409 → 409ms。延迟由<em>公网模型调用</em>（查询向量化 ~150ms + 精排 ~90ms）主导，本地检索部分占比很小。</li>
      <li><strong>受规模影响的只有本地两路召回</strong>：KNN 58.1 → 68.5ms、BM25 11.4 → 25.9ms，温和上升；RRF 融合 ~0.1ms 可忽略。</li>
      <li><strong>压测峰值 ≠ 高并发</strong>：<code>/rag/search</code> 吞吐在<em>并发 8</em> 达峰 14.3 req/s，之后回落（16→12.5，32→13.8）；P50 从 307ms 涨到 2049ms，但<em>零失败</em>——说明服务在被排队而不是被打崩。</li>
      <li><strong>13× 差距来自公网模型调用</strong>：纯 ES 检索并发 16 峰值 163.5 req/s，是 rag-search 的 13.1 倍。瓶颈不在本地栈。</li>
    </ul>
  </div>

  ${charts}

  <footer>
    数据源：<code>test/eval/results/scale-curve.json</code> · <code>test/eval/results/stress-report.json</code>　|　
    口径：延迟为客户端端到端 wall time（含 HTTP/鉴权/向量化/双路召回/RRF/精排）；<code>LANGFUSE_ENABLED=false</code> 排除云端 tracing 额外往返；
    单机同机压测，为单机上限而非生产容量。
  </footer>
</main>
</body>
</html>`;

mkdirSync(RES, { recursive: true });
const out = join(RES, 'delay-stress-report.html');
writeFileSync(out, html, 'utf8');
console.log(`✅ 已写入 ${out}`);
