#!/usr/bin/env node
/**
 * 知识图谱探针（补「方案对比卡 · 卡 4」的证据缺口）
 *
 * 卡 4 的四个缺口：
 *   [ ] 图谱检索延迟（工单只说「降低延迟与降级面」，无数字）
 *   [ ] 图谱规模与结构（演示库 82 实体量级，需现测）
 *   [ ] 一个「图谱才能答」的具体真实问题
 *   [ ] Agent 实际调用 retrieve_graph 的频率
 *
 * 本脚本给出前三个的**可复现数字**（第四个需要多轮 Agent trace，不在本脚本范围）。
 *
 * 用法：node test/eval/kg-probe.mjs
 * 可选环境变量：EVAL_BASE_URL、KG_PROBE_REPEATS（默认 20）、KG_PROBE_OUT
 */

import 'dotenv/config';
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import neo4j from 'neo4j-driver';

const BASE = process.env.EVAL_BASE_URL ?? 'http://localhost:3000';
const USERNAME = process.env.EVAL_USERNAME ?? 'admin';
const PASSWORD = process.env.EVAL_PASSWORD ?? '123456';
const REPEATS = Number(process.env.KG_PROBE_REPEATS ?? 20);
const HERE = dirname(fileURLToPath(import.meta.url));
const RESULTS_DIR = join(HERE, 'results');

/**
 * 关系型问题样例分两类：
 * - hit：图谱里**确实存在**的关系（用来证明 retrieve 侧的链路可用）
 * - miss：工单/对比卡声称图谱能答、但本环境**实际答不出**的问题（用来暴露抽取质量问题）
 */
const RELATION_QUERIES = [
  { q: 'Vue', expect: 'hit', desc: '技术类实体：简历文档里 Vue 的关系被抽出来了' },
  { q: 'Element Plus', expect: 'hit', desc: '技术类实体：组件库关系' },
  { q: '王工', expect: 'miss', desc: '制度类实体：「王工—负责→技术评估」这条关系**没有**被抽出' },
  { q: '技术评估', expect: 'miss', desc: '制度类环节：连实体都没抽出来' },
  { q: 'PMO', expect: 'miss', desc: '制度类组织：只有实体、没有关系' },
];

/** Neo4j 直查（tracing 之外的原始图数据，用来量化抽取产出） */
const CYPHER = {
  relTypes: 'MATCH ()-[r]->() RETURN type(r) AS rel, count(*) AS c ORDER BY c DESC',
  perDoc:
    'MATCH (d:Document)-[:HAS_CHUNK]->(:Chunk)-[:MENTIONS]->(e:Entity) ' +
    'WITH d, count(DISTINCT e) AS ents ' +
    'MATCH (d)-[:HAS_CHUNK]->(:Chunk)-[:MENTIONS]->(:Entity)-[r:RELATED_TO]-(:Entity) ' +
    'RETURN d.title AS doc, ents AS entities, count(DISTINCT r) AS related_edges ORDER BY related_edges DESC',
  sampleRel:
    'MATCH (a:Entity)-[r:RELATED_TO]->(b:Entity) RETURN a.name AS a, r.relation AS rel, b.name AS b LIMIT 15',
};

/** 延迟探测的端点清单 */
const PROBES = [
  { name: 'GET /kg/search?q=王工', url: '/kg/search?q=%E7%8E%8B%E5%B7%A5&pageSize=5' },
  { name: 'GET /kg/nodes?label=entity&q=王工', url: '/kg/nodes?label=entity&q=%E7%8E%8B%E5%B7%A5&pageSize=10' },
  { name: 'GET /kg/edges?rel=related_to&entity=王工', url: '/kg/edges?rel=related_to&entity=%E7%8E%8B%E5%B7%A5&pageSize=50' },
  { name: 'GET /kg/overview?limit=2000', url: '/kg/overview?limit=2000' },
  { name: 'GET /rag/search?q=王工（对照：文档侧）', url: '/rag/search?q=%E7%8E%8B%E5%B7%A5&top_k=5&rerank=true&mode=hybrid' },
];

const msg = (err) => (err instanceof Error ? err.message : String(err));
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const percentile = (xs, p) => {
  if (!xs.length) return 0;
  const sorted = [...xs].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[idx];
};
const fmt = (v, d = 1) => (v === null || v === undefined ? '—' : Number(v).toFixed(d));

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

async function get(token, path) {
  const t0 = Date.now();
  const res = await fetch(`${BASE}${path}`, { headers: { Authorization: `Bearer ${token}` } });
  const wall = Date.now() - t0;
  const text = await res.text();
  if (!res.ok) throw new Error(`${path} ${res.status}: ${text.slice(0, 200)}`);
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`${path} 返回非 JSON`);
  }
  return { wall, json };
}

async function main() {
  mkdirSync(RESULTS_DIR, { recursive: true });
  const token = await login();

  // ── ① 图谱规模与结构（API 总览） ──
  const { json: overview, wall: overviewWall } = await get(token, '/kg/overview?limit=2000');
  const nodes = overview.nodes ?? [];
  const edges = overview.edges ?? [];
  const stats = overview.stats ?? {};
  const byKind = {};
  for (const n of nodes) byKind[n.kind ?? 'unknown'] = (byKind[n.kind ?? 'unknown'] ?? 0) + 1;
  const edgeByKind = {};
  for (const e of edges) edgeByKind[e.kind ?? 'unknown'] = (edgeByKind[e.kind ?? 'unknown'] ?? 0) + 1;
  const typeDist = overview.typeDist ?? [];
  /** typeDist 可能是 [{type,count}] 数组或 {type: count} 对象，统一成 [type, count][] */
  const typePairs = Array.isArray(typeDist)
    ? typeDist.map((x) => [x.type ?? String(x), x.count ?? 0])
    : Object.entries(typeDist);

  console.log(`图谱规模（/kg/overview）：节点 ${nodes.length}　边 ${edges.length}　overview 耗时 ${overviewWall}ms`);
  console.log(`  stats：${JSON.stringify(stats)}`);
  console.log(`  节点按 kind：${JSON.stringify(byKind)}　边按 kind：${JSON.stringify(edgeByKind)}`);
  console.log(`  实体类型分布：${typePairs.map(([k, v]) => `${k}=${v}`).join('、')}\n`);

  // ── ①b 抽取产出量化（Neo4j 直查） ──
  const driver = neo4j.driver(
    process.env.NEO4J_URI ?? 'bolt://localhost:7687',
    neo4j.auth.basic(process.env.NEO4J_USER ?? 'neo4j', process.env.NEO4J_PASSWORD ?? ''),
  );
  const session = driver.session();
  const q = async (cypher) => {
    const r = await session.run(cypher);
    return r.records.map((rec) => Object.fromEntries(rec.keys.map((k) => [k, rec.get(k)])));
  };
  let relTypes = [];
  let perDoc = [];
  let sampleRel = [];
  try {
    relTypes = (await q(CYPHER.relTypes)).map((r) => ({ rel: r.rel, count: Number(r.c) }));
    perDoc = (await q(CYPHER.perDoc)).map((r) => ({
      doc: r.doc,
      entities: Number(r.entities),
      related_edges: Number(r.related_edges),
    }));
    sampleRel = (await q(CYPHER.sampleRel)).map((r) => ({ a: r.a, rel: r.rel, b: r.b }));
    console.log('图谱关系总量（Neo4j）：');
    for (const r of relTypes) console.log(`  ${r.rel} = ${r.count}`);
    console.log('按文档的抽取产出：');
    for (const d of perDoc) console.log(`  ${d.doc}：实体 ${d.entities}　RELATED_TO 边 ${d.related_edges}`);
    console.log('');
  } finally {
    await session.close();
    await driver.close();
  }

  // ── ② 延迟 ──
  const lat = [];
  console.log(`── 端点延迟（每项 ${REPEATS} 次）──`);
  for (const p of PROBES) {
    const samples = [];
    let err = null;
    for (let i = 0; i < REPEATS; i++) {
      try {
        const { wall } = await get(token, p.url);
        samples.push(wall);
      } catch (e) {
        err = msg(e);
      }
    }
    const row = {
      name: p.name,
      n: samples.length,
      mean: mean(samples),
      p50: percentile(samples, 50),
      p95: percentile(samples, 95),
      max: samples.length ? Math.max(...samples) : 0,
      error: err,
    };
    lat.push(row);
    console.log(
      `${p.name.padEnd(46)} 均值 ${fmt(row.mean)} ms  P50 ${fmt(row.p50)}  P95 ${fmt(row.p95)}  最大 ${fmt(row.max)}` +
        (err ? `  ⚠️ ${err.slice(0, 60)}` : ''),
    );
  }

  // ── ③ 「图谱才能答」的具体样例 ──
  const samples = [];
  console.log('\n── 关系型问题对照（文档侧 vs 图谱侧）──');
  for (const rq of RELATION_QUERIES) {
    const rag = await get(token, `/rag/search?q=${encodeURIComponent(rq.q)}&top_k=5&rerank=true&mode=hybrid`);
    const kg = await get(token, `/kg/search?q=${encodeURIComponent(rq.q)}&pageSize=5`);
    const kgNodes = await get(token, `/kg/nodes?label=entity&q=${encodeURIComponent(rq.q)}&pageSize=10`);
    const kgEdges = await get(
      token,
      `/kg/edges?rel=related_to&entity=${encodeURIComponent(rq.q)}&pageSize=50`,
    );
    const rec = {
      query: rq.q,
      expect: rq.expect,
      desc: rq.desc,
      rag: rag.json,
      kg: kg.json,
      kgNodes: kgNodes.json,
      kgEdges: kgEdges.json,
    };
    samples.push(rec);
    const ragTitles = [...new Set((rag.json.items ?? []).map((i) => i.doc_title))];
    const edgeStr = (kg.json.edges ?? [])
      .map(
        (e) =>
          `${e.sourceName ?? e.source ?? e.a ?? e.from} -${e.relation ?? e.rel}-> ` +
          `${e.targetName ?? e.target ?? e.b ?? e.to}`,
      )
      .join('；');
    console.log(
      `\n【${rq.q}】(${rq.expect}) ${rq.desc}\n  文档侧 /rag/search Top5 文档：${ragTitles.join(' / ') || '（空）'}` +
        `\n  图谱侧 /kg/search 命中实体：${(kg.json.entities ?? []).map((e) => e.name).join('、') || '（空）'}` +
        `\n  图谱侧 /kg/search 命中关系：${edgeStr || '（空）'}` +
        `\n  图谱侧 /kg/edges?entity=... 关联边数：${(kgEdges.json.items ?? []).length}`,
    );
  }

  const lines = [];
  lines.push('# 知识图谱探针结果（卡 4 证据补齐）');
  lines.push('');
  lines.push(`- 采集时间：${new Date().toISOString()}`);
  lines.push(`- 被测 BASE：\`${BASE}\``);
  lines.push(`- 延迟口径：客户端端到端 wall time（每端点 ${REPEATS} 次，含 JWT 鉴权与 JSON 序列化）`);
  lines.push('- 图谱检索机制：Cypher 属性子串匹配 `toLower(x) CONTAINS toLower($q)`，**无全文索引**（controller 注释明确「不建索引」）');
  lines.push('');
  lines.push('## 图谱规模');
  lines.push('');
  lines.push(`- \`/kg/overview\` 自报 stats：\`${JSON.stringify(stats)}\``);
  lines.push(`- 返回节点 ${nodes.length}（按 kind：${Object.entries(byKind).map(([k, v]) => `${k}=${v}`).join('、')}）`);
  lines.push(`- 返回边 ${edges.length}（按 kind：${Object.entries(edgeByKind).map(([k, v]) => `${k}=${v}`).join('、')}）`);
  lines.push(`- 实体类型分布：${typePairs.map(([k, v]) => `${k} ${v}`).join(' / ')}`);
  lines.push('');
  lines.push('### 关系总量（Neo4j 直查，口径：`MATCH ()-[r]->() RETURN type(r), count(*)`）');
  lines.push('');
  lines.push('| 关系类型 | 数量 |');
  lines.push('| :--- | ---: |');
  for (const r of relTypes) lines.push(`| ${r.rel} | ${r.count} |`);
  lines.push('');
  lines.push('### 按文档的抽取产出（口径见下方 Cypher）');
  lines.push('');
  lines.push('| 文档 | 抽出的实体数 | RELATED_TO 边数 |');
  lines.push('| :--- | ---: | ---: |');
  for (const d of perDoc) lines.push(`| ${d.doc} | ${d.entities} | ${d.related_edges} |`);
  lines.push('');
  lines.push('```cypher');
  lines.push(CYPHER.perDoc);
  lines.push('```');
  lines.push('');
  lines.push('### RELATED_TO 抽样（前 15 条）');
  lines.push('');
  lines.push('| 头实体 | 关系 | 尾实体 |');
  lines.push('| :--- | :-: | :--- |');
  for (const s of sampleRel) lines.push(`| ${s.a} | ${s.rel} | ${s.b} |`);
  lines.push('');
  lines.push('## 端点延迟');
  lines.push('');
  lines.push('| 端点 | 样本 | 均值 ms | P50 ms | P95 ms | 最大 ms | 备注 |');
  lines.push('| :--- | ---: | ---: | ---: | ---: | ---: | :--- |');
  for (const r of lat) {
    lines.push(`| \`${r.name}\` | ${r.n} | ${fmt(r.mean)} | ${fmt(r.p50)} | ${fmt(r.p95)} | ${fmt(r.max)} | ${r.error ? `⚠️ ${r.error.slice(0, 80)}` : '—'} |`);
  }
  lines.push('');
  lines.push('> 对照项说明：最后一行是**文档侧** `/rag/search` 在同 query 下的耗时，用来对比"图谱一次往返"与"混合检索一次往返"的成本差。');
  lines.push('> 该对照的耗时里包含查询向量化与精排两次**公网模型调用**，所以差距反映的是链路结构差异，不是 Neo4j 本身慢。');
  lines.push('');
  lines.push('## 关系型问题样例：文档侧 vs 图谱侧');
  lines.push('');
  for (const s of samples) {
    lines.push(`### 「${s.query}」——${s.expect === 'hit' ? '图谱应能答' : '图谱应能答但实际答不出'}：${s.desc}`);
    lines.push('');
    lines.push(`- 文档侧 \`/rag/search\` Top5 命中文档：${[...new Set((s.rag.items ?? []).map((i) => i.doc_title))].join(' / ') || '（空）'}`);
    lines.push(`- 图谱侧 \`/kg/search\` 命中实体：${(s.kg.entities ?? []).map((e) => `${e.name}${e.type ? `(${e.type})` : ''}`).join('、') || '（空）'}`);
    lines.push(`- 图谱侧 \`/kg/search\` 命中关系：${(s.kg.edges ?? []).map((e) => `${e.sourceName ?? e.source ?? e.a ?? e.from} -${e.relation ?? e.rel}-> ${e.targetName ?? e.target ?? e.b ?? e.to}`).join('；') || '（空）'}`);
    lines.push(`- 图谱侧 \`/kg/edges?entity=${s.query}\` 关联边：${(s.kgEdges.items ?? []).length} 条`);
    lines.push('');
    lines.push('<details><summary>原始返回（截断）</summary>');
    lines.push('');
    lines.push('```json');
    lines.push(
      JSON.stringify(
        {
          ragItems: (s.rag.items ?? []).map((i) => ({ doc_title: i.doc_title, chunk_index: i.chunk_index, score: i.score })),
          kgEntities: s.kg.entities,
          kgEdges: s.kg.edges,
          kgNodes: (s.kgNodes.items ?? []).slice(0, 10),
          kgRelEdges: (s.kgEdges.items ?? []).slice(0, 20),
        },
        null,
        2,
      ).slice(0, 4000),
    );
    lines.push('```');
    lines.push('');
    lines.push('</details>');
    lines.push('');
  }

  const md = lines.join('\n');
  const out = process.env.KG_PROBE_OUT ?? join(RESULTS_DIR, 'kg-probe.md');
  writeFileSync(out, md, 'utf8');
  writeFileSync(
    join(RESULTS_DIR, 'kg-probe.json'),
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        overview: { nodes: nodes.length, edges: edges.length, byKind, edgeByKind, typeDist, stats },
        relTypes,
        perDoc,
        sampleRel,
        latency: lat,
        samples,
      },
      null,
      2,
    ),
    'utf8',
  );
  console.log(`\n已写入 ${out} 与同目录 kg-probe.json`);
}

main().catch((err) => {
  console.error(`运行失败：${msg(err)}`);
  process.exit(1);
});
