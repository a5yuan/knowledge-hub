#!/usr/bin/env node
/**
 * s12 · 重发布幂等性（工单 24 指标 #12）
 *
 * 断言：同一文档连续发布 3 次，ES `kh_chunk` 的 chunk 数三次完全一致（且等于基线）。
 *
 * 为什么这条重要：发布链路是「文档 → MQ → 切片 → embedding → 写 ES」。
 * 如果重发布是「追加」而不是「按 doc 重写」，chunk 会翻倍 —— 检索时同一段内容
 * 出现多份，RRF 融合后把重复内容顶到前面，用户看到的 Top-K 全是同一段话。
 * 这个缺陷**不会报错**，只会让检索质量悄悄变差。
 *
 * 三库取舍：
 * - ES `kh_chunk`：核心指标，必测
 * - Mongo `document_content.version`：`version` 是「正文编辑」的版本号，
 *   重发布不改正文，所以它应当**不变**（工单原文写「应递增」，与实现不符，已在报告里标注）
 * - Neo4j `HAS_CHUNK` 关系数：构图走异步管线，发布后立即查询时序不可靠，
 *   本脚本记录但不作为断言（标 skipped）
 *
 * 用法：
 *   EVAL_PASSWORD=xxx node test/eval/suite/s12-idempotent.mjs
 *   ES_URL=http://localhost:9200 可覆盖 ES 地址
 */
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import {
  login,
  apiGet,
  apiPost,
  preflight,
} from '../lib/base.mjs';
import { createSuiteDir, writeItemJson } from '../lib/report.mjs';

const ES_URL = process.env.ES_URL ?? 'http://localhost:9200';
const ES_INDEX = 'kh_chunk';
const PUBLISH_ROUNDS = 3;
const MONGO_CONTAINER = 'knowledge_hub_mongodb';
const NEO4J_CONTAINER = 'knowledge_hub_neo4j';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** ES 按 doc_id 统计 chunk 数 */
async function esChunkCount(docId) {
  const res = await fetch(`${ES_URL}/${ES_INDEX}/_count`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: { term: { doc_id: docId } } }),
  });
  if (!res.ok) throw new Error(`ES _count ${res.status}`);
  const json = await res.json();
  return json.count;
}

/**
 * 轮询直到计数稳定。
 *
 * ⚠️ 不能只判「连续两次相同」：提审模式下 publish 会先 `clearThreeIndexes`，
 * 索引被清空的瞬间 count=0，连续两次读到的 0 会被误判为「稳定」。
 * 因此要求 `count >= minCount`（默认 1）才允许认定稳定。
 */
async function waitStableCount(docId, { minCount = 1, timeoutMs = 60000 } = {}) {
  const t0 = Date.now();
  let last = -1;
  let stable = 0;
  while (Date.now() - t0 < timeoutMs) {
    const c = await esChunkCount(docId);
    if (c === last && c >= minCount) {
      stable += 1;
      if (stable >= 2) return { count: c, waited_ms: Date.now() - t0 };
    } else {
      stable = 0;
      last = c;
    }
    await sleep(1500);
  }
  return { count: last, waited_ms: Date.now() - t0, timed_out: true };
}

/** 从 MONGO_URI 解析凭据，避免硬编码 */
function mongoEval(js) {
  const uri = process.env.MONGO_URI;
  if (!uri) throw new Error('缺少 MONGO_URI');
  const u = new URL(uri);
  const db = u.pathname.replace(/^\//, '') || 'knowledge_hub';
  const authDb = u.searchParams.get('authSource') || 'admin';
  const out = execFileSync(
    'docker',
    [
      'exec', MONGO_CONTAINER, 'mongosh',
      '--quiet',
      '-u', decodeURIComponent(u.username),
      '-p', decodeURIComponent(u.password),
      '--authenticationDatabase', authDb,
      '--eval', `db.getSiblingDB(${JSON.stringify(db)}).${js}`,
    ],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  );
  return out.trim();
}

/** 读 Mongo 正文的 version */
function mongoVersion(docId) {
  try {
    const out = mongoEval(
      `document_content.findOne({documentId:${JSON.stringify(docId)}},{version:1,_id:0})`,
    );
    const m = out.match(/"version"\s*:\s*(\d+)/);
    return m ? Number(m[1]) : null;
  } catch {
    return null;
  }
}

/** Neo4j chunk 关系数（尽力而为，失败返回 null） */
function neo4jChunkCount(docId) {
  const pwd = process.env.NEO4J_PASSWORD;
  if (!pwd) return null;
  try {
    const out = execFileSync(
      'docker',
      [
        'exec', NEO4J_CONTAINER, 'cypher-shell',
        '-u', process.env.NEO4J_USER ?? 'neo4j',
        '-p', pwd,
        `MATCH (d:Document)-[:HAS_CHUNK]->(c:Chunk) WHERE d.docId='${docId}' RETURN count(c) AS n`,
      ],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
    const m = out.match(/^(\d+)$/m);
    return m ? Number(m[1]) : null;
  } catch {
    return null;
  }
}

/**
 * 等图谱构图完成 —— **但有严格上限**。
 *
 * 实测：构图走独立 `kg.queue`，要逐块调 LLM 抽取实体关系，
 * 20 个 chunk 花了 **9 分 20 秒**（17:40:43 分块完成 → 17:50:06 管线完成）。
 * 这个量级远超评测可接受的等待窗口，所以本脚本只做**短窗口抽样**：
 * 能读到就记录，读不到就把 Neo4j 标为 `sampled` 而非 `asserted`，
 * 不把「窗口内没读到」误报成「幂等失败」。
 */
async function waitNeo4jCount(docId, timeoutMs = 12000) {
  if (!process.env.NEO4J_PASSWORD) return { count: null, skipped: '未配置 NEO4J_PASSWORD' };
  const t0 = Date.now();
  let last = null;
  while (Date.now() - t0 < timeoutMs) {
    const n = neo4jChunkCount(docId);
    if (typeof n === 'number' && n > 0) {
      return { count: n, waited_ms: Date.now() - t0, sampled: true };
    }
    last = n;
    await sleep(2000);
  }
  return { count: last, waited_ms: Date.now() - t0, timed_out: true, sampled: true };
}

async function pickPublishedDoc(token) {
  // 指定 TARGET_DOC_ID 可复跑同一文档
  const wanted = process.env.TARGET_DOC_ID;
  if (wanted) {
    const r = await apiGet(token, `/document/${wanted}`);
    if (r.status !== 200) throw new Error(`文档 ${wanted} 不存在（${r.status}）`);
    return r.json;
  }

  /**
   * 自动选「chunk 数最多」的已发布文档。
   *
   * 为什么不能随便取第一条：演示语料里有的文档只有 1 个 chunk，
   * 而「重发布是否产生重复切片」这个断言在 1 片的文档上**恒成立且毫无意义**
   * （1 次发布 → 1 片；3 次发布 → 还是 1 片，无论实现多烂）。
   * 必须挑一个多片文档，才能看出「按 doc 重写」和「追加」的区别。
   */
  const aggRes = await fetch(`${ES_URL}/${ES_INDEX}/_search`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      size: 0,
      aggs: { by_doc: { terms: { field: 'doc_id', size: 50 } } },
    }),
  });
  if (!aggRes.ok) throw new Error(`ES agg ${aggRes.status}`);
  const agg = await aggRes.json();
  const buckets = (agg.aggregations?.by_doc?.buckets ?? []).sort(
    (a, b) => b.doc_count - a.doc_count,
  );
  if (!buckets.length) throw new Error('ES 里没有任何 chunk，无法测试幂等');

  // 从多到少试，跳过已删除/归档的
  for (const b of buckets) {
    const r = await apiGet(token, `/document/${b.key}`);
    if (r.status !== 200) continue;
    if (r.json?.deleted || r.json?.status === 3) continue;
    console.log(`  （选用 chunk 最多的文档：${r.json.title}，${b.doc_count} 片）`);
    return r.json;
  }
  throw new Error('没有可用于幂等测试的已发布文档');
}

/**
 * 确保目标文档处于「已发布」状态。
 *
 * 上一次失败的测试可能把文档留在「待审核」（publish 后未 approve），
 * 此时直接 publish 会撞 400。先读状态、必要时补一次 approve，脚本才可重复运行。
 */
async function ensurePublished(token, docId) {
  const cur = await apiGet(token, `/document/${docId}`);
  const status = cur.json?.status;
  if (status === 2) {
    const ap = await apiPost(token, `/document/${docId}/approve`, {});
    console.log(`  （文档处于待审核，已补 approve → HTTP ${ap.status}）`);
    return ap.status < 300;
  }
  if (status === 3) {
    throw new Error('目标文档已归档，无法用于幂等测试');
  }
  return true;
}

async function main() {
  const suiteDir = process.env.SUITE_DIR ?? createSuiteDir();
  console.log('s12 · 重发布幂等性');
  console.log('='.repeat(64));

  const token = await login();
  const issues = await preflight(token);
  if (issues.length) {
    console.log('❌ 环境体检未通过：');
    for (const i of issues) console.log('   - ' + i);
    writeItemJson(suiteDir, 's12-idempotent', { status: 'skip', issues });
    process.exitCode = 2;
    return;
  }
  console.log('✅ 环境体检通过\n');

  const doc = await pickPublishedDoc(token);
  const docId = String(doc.id);
  console.log(`目标文档：${doc.title}（id=${docId}）`);
  await ensurePublished(token, docId);

  const baseline = await waitStableCount(docId);
  console.log(`基线：ES chunk = ${baseline.count}（等待 ${baseline.waited_ms}ms）`);
  const v0 = mongoVersion(docId);
  const ng0 = await waitNeo4jCount(docId);
  const n0 = ng0.count;
  console.log(`基线：Mongo version = ${v0 ?? '(取不到)'}  Neo4j 关系 = ${n0 ?? '(取不到)'}\n`);

  const rounds = [];
  for (let i = 1; i <= PUBLISH_ROUNDS; i += 1) {
    const t0 = Date.now();
    const pub = await apiPost(token, `/document/${docId}/publish`, {});
    /**
     * 提审模式（REVIEW_ENABLED=true）下 publish 只把文档转成「待审核」并清空三库，
     * 必须补一次 approve 才会重新切片写索引 —— 否则 chunk 永远停在 0，
     * 而且第二次 publish 会撞「已在待审核中」返回 400。
     * 直发模式下 publish 返回 status=1，无需 approve。
     */
    const returnedStatus = pub.json?.status;
    let approve = null;
    if (pub.status < 300 && returnedStatus === 2) {
      approve = await apiPost(token, `/document/${docId}/approve`, {});
    }
    const settled = await waitStableCount(docId);
    const v = mongoVersion(docId);
    const ng = await waitNeo4jCount(docId);
    const n = ng.count;
    rounds.push({
      round: i,
      publish_status: pub.status,
      publish_returned_status: returnedStatus ?? null,
      approve_status: approve ? approve.status : null,
      publish_error: pub.status >= 300 ? pub.text.slice(0, 160) : null,
      approve_error: approve && approve.status >= 300 ? approve.text.slice(0, 160) : null,
      es_chunk: settled.count,
      waited_ms: settled.waited_ms,
      timed_out: !!settled.timed_out,
      mongo_version: v,
      neo4j_chunks: n,
      elapse_ms: Date.now() - t0,
    });
    console.log(
      `  第 ${i} 次：publish→${pub.status}（status=${returnedStatus ?? '-'}）` +
        `${approve ? ` approve→${approve.status}` : ''}  ES chunk=${settled.count}（${(settled.waited_ms / 1000).toFixed(1)}s）  version=${v ?? '-'}  neo4j=${n ?? '-'}`,
    );
  }

  const counts = rounds.map((r) => r.es_chunk);
  const allSameAsBaseline = counts.every((c) => c === baseline.count);
  const publishOk = rounds.every(
    (r) =>
      r.publish_status < 300 &&
      (r.approve_status === null || r.approve_status < 300),
  );
  const noTimeout = rounds.every((r) => !r.timed_out);

  const status = publishOk && allSameAsBaseline && noTimeout ? 'pass' : 'fail';
  const conclusion = !publishOk
    ? `第 ${rounds.find((r) => r.publish_status >= 300)?.round} 次发布返回非 2xx`
    : !allSameAsBaseline
      ? `chunk 数在重发布后发生变化（基线 ${baseline.count} → ${counts.join(' / ')}），疑似「追加」而非「按 doc 重写」`
      : !noTimeout
        ? 'ES 计数在超时窗口内未稳定，无法判定'
        : `连续 ${PUBLISH_ROUNDS} 次发布 chunk 数恒为 ${baseline.count}，未产生重复切片`;

  const payload = {
    id: 's12',
    name: '重发布幂等性',
    status,
    metric: `ES chunk ${baseline.count} → ${counts.join(' / ')}`,
    target: '三次发布后计数不变',
    conclusion,
    doc: { id: docId, title: doc.title },
    baseline: { es_chunk: baseline.count, mongo_version: v0, neo4j_chunks: n0 },
    rounds,
    notes: {
      mongo_version:
        'version 是「正文编辑」版本号，重发布不改正文，因此应保持不变（工单原文写「应递增」，与实际实现不符）',
      neo4j: '构图走异步管线，发布后立即查询时序不可靠，本次仅记录不作断言（status=skipped）',
    },
  };
  writeItemJson(suiteDir, 's12-idempotent', payload);

  console.log('');
  console.log('='.repeat(64));
  console.log(`结论：${conclusion}`);
  console.log(`状态：${status === 'pass' ? '✅ 通过' : '❌ 失败'}`);
  console.log(`明细：${join(suiteDir, 's12-idempotent.json')}`);
  if (status !== 'pass') process.exitCode = 1;
}

main().catch((err) => {
  console.error('s12 执行失败:', err);
  process.exitCode = 1;
});
