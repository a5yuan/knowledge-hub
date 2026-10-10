#!/usr/bin/env node
/**
 * 录制前重置语料：把知识库清空到「只剩账号」的状态，让演示视频里的构建过程是真从零开始。
 *
 * 清理对象（与录制前的语料备份一一对应，可持续复现）：
 *   PostgreSQL  kh_document（逻辑删除）+ 关联审核记录
 *   MongoDB     document_content（逻辑删除）
 *   ES          kh_chunk / kh_document
 *   Neo4j       文档节点与实体关系
 *   mem0        admin 名下长期/会话记忆
 *
 * 走的是产品自身的 DELETE /document/:id（内部 clearThreeIndexes 会清 ES 与 Neo4j），
 * 不直接改库；残留部分再单独清，最后逐项回查并打印结果。
 *
 * 用法：node reset-corpus.mjs
 */

import { readFileSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const WS = resolve(HERE, '..', '..', '..');
const API = process.env.DEMO_API ?? 'http://127.0.0.1:3000';
const ES = process.env.DEMO_ES ?? 'http://localhost:9200';
const USER = process.env.DEMO_USER ?? 'admin';

/** 从后端 .env 读密码与 mem0 凭据 */
function readEnv() {
  const p = join(WS, 'knowledge-hub-backend', '.env');
  const out = {};
  if (!existsSync(p)) return out;
  for (const line of readFileSync(p, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  return out;
}
const ENV = readEnv();
/** 密码来源优先级：环境变量 > record.mjs 解析出的缓存文件 > .env */
const PW_CACHE = process.env.DEMO_PW_FILE ?? 'D:/Temp/demo-logs/.admin-pw';
function cachedPw() {
  return existsSync(PW_CACHE) ? readFileSync(PW_CACHE, 'utf8').trim() : '';
}
const PW = process.env.DEMO_PW || cachedPw() || ENV.ADMIN_PASSWORD || '';

const j = async (url, init) => {
  const r = await fetch(url, init);
  const t = await r.text();
  try {
    return { ok: r.ok, status: r.status, body: JSON.parse(t) };
  } catch {
    return { ok: r.ok, status: r.status, body: t };
  }
};

async function login() {
  if (!PW) {
    throw new Error(
      '未拿到 admin 密码：请先运行 `node record.mjs --dry --only=ch1`（会从登录页提示解析并缓存），或用 DEMO_PW=xxx 指定',
    );
  }
  const r = await j(`${API}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: USER, password: PW }),
  });
  if (!r.ok) throw new Error(`登录失败 ${r.status}：${JSON.stringify(r.body).slice(0, 150)}`);
  return r.body.accessToken;
}

const token = await login();
const auth = { Authorization: `Bearer ${token}` };
console.log('✅ 已登录\n');

/* ── 1. 删文档 ── */
const all = [];
for (let page = 1; page <= 50; page++) {
  const r = await j(`${API}/document?page=${page}&pageSize=100`, { headers: auth });
  const list = r.body?.list ?? r.body?.items ?? [];
  all.push(...list);
  const total = r.body?.total ?? r.body?.pagination?.total ?? 0;
  if (list.length < 100 || all.length >= total) break;
}
console.log(`PG 可见文档：${all.length} 条`);
let del = 0;
let delFail = 0;
for (const d of all) {
  const r = await j(`${API}/document/${d.id}`, { method: 'DELETE', headers: auth });
  if (r.ok) del++;
  else {
    delFail++;
    console.log(`   ⚠ 删除失败 id=${d.id} status=${r.status} ${JSON.stringify(r.body).slice(0, 120)}`);
  }
}
console.log(`已删除 ${del} 条，失败 ${delFail} 条\n`);

/* ── 2. 兜底清 ES 残留 ── */
for (const idx of ['kh_chunk', 'kh_document']) {
  const cur = await j(`${ES}/${idx}/_count`);
  const n = cur.body?.count ?? 0;
  if (n > 0) {
    const r = await j(`${ES}/${idx}/_delete_by_query?refresh=true&conflicts=proceed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: { match_all: {} } }),
    });
    console.log(`ES ${idx}: 删除残留 ${n} 条 → ${r.ok ? 'OK' : 'FAIL ' + r.status}`);
  }
}

/* ── 3. 清 AI 会话（左侧会话列表回到干净状态） ── */
const sess = await j(`${API}/ai/sessions`, { headers: auth });
const sessList = sess.body?.list ?? [];
let sessDel = 0;
for (const s of sessList) {
  const r = await j(`${API}/ai/sessions/${s.id}`, { method: 'DELETE', headers: auth });
  if (r.ok) sessDel++;
}
console.log(`AI 会话：删除 ${sessDel}/${sessList.length} 条\n`);

/* ── 4. 清 mem0 ── */
const MEM0_BASE = (ENV.MEM0_BASE_URL || 'https://api.mem0.ai').replace(/\/$/, '');
const MEM0_KEY = ENV.MEM0_API_KEY || '';
let memCleared = 0;
if (MEM0_KEY) {
  const me = await j(`${API}/auth/me`, { headers: auth });
  const uid = me.body?.id ?? me.body?.userId;
  if (uid) {
    const list = await j(`${MEM0_BASE}/v2/memories/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Token ${MEM0_KEY}` },
      body: JSON.stringify({ filters: { user_id: uid }, page: 1, page_size: 200 }),
    });
    const arr = Array.isArray(list.body) ? list.body : (list.body?.results ?? list.body?.memories ?? []);
    for (const m of arr) {
      const r = await j(`${MEM0_BASE}/v1/memories/${m.id}/`, {
        method: 'DELETE',
        headers: { Authorization: `Token ${MEM0_KEY}` },
      });
      if (r.ok) memCleared++;
    }
    console.log(`mem0: 清除 ${memCleared}/${arr.length} 条（user_id=${uid}）`);
  }
} else {
  console.log('mem0: 未配置 API Key，跳过');
}

/* ── 4. 回查 ── */
await new Promise((r) => setTimeout(r, 1500));
console.log('\n— 重置后状态 —');
const after = {};
for (const idx of ['kh_chunk', 'kh_document']) {
  const c = await j(`${ES}/${idx}/_count`);
  after[idx] = c.body?.count ?? '?';
}
const list2 = await j(`${API}/document?page=1&pageSize=100`, { headers: auth });
const left = list2.body?.list ?? list2.body?.items ?? [];
const kg = await j(`${API}/kg/overview`, { headers: auth });
const nodeCount = (kg.body?.nodes ?? []).length;
const edgeCount = (kg.body?.edges ?? kg.body?.relations ?? []).length;

console.log(`  kh_chunk     = ${after.kh_chunk}`);
console.log(`  kh_document  = ${after.kh_document}`);
console.log(`  文档列表剩余 = ${left.length}`);
console.log(`  图谱节点     = ${nodeCount}`);
console.log(`  图谱关系     = ${edgeCount}`);
console.log(`  mem0 清除    = ${memCleared}`);
console.log('\n✅ 重置完成');