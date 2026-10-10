#!/usr/bin/env node
/**
 * 演示视频录制前 · 意图路由预检
 *
 * 直连后端 SSE，跑一遍录制计划里的 4 个提问，打印每次的 intent / 工具调用 / 答案长度，
 * 用于在真正录制前确认四种场景都能被触发（避免录到一半发现某条路由不命中）。
 *
 * 用法：node probe-intents.mjs
 */

const BASE = process.env.DEMO_API ?? 'http://127.0.0.1:3000';
const USER = process.env.DEMO_USER ?? 'admin';
const PW = process.env.DEMO_PW ?? '123456';

const QUESTIONS = [
  { tag: 'Q1 纯知识库', q: '钢铁行业数字化转型的发展目标里，关键工序数控化率要达到多少？' },
  { tag: 'Q2 联网搜索', q: '2026 年钢铁行业数字化转型有哪些最新政策？' },
  { tag: 'Q3 知识库不足→联网', q: '我们知识库里的钢铁行业数字化转型指南提出了哪些重点任务？另外工信部近期还发布了哪些相关配套政策？' },
  { tag: 'Q4 其他情形（闲聊）', q: '你好，你是谁？' },
];

async function login() {
  const r = await fetch(`${BASE}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: USER, password: PW }),
  });
  if (!r.ok) throw new Error(`登录失败 ${r.status}`);
  return (await r.json()).accessToken;
}

async function ask(token, content) {
  const t0 = Date.now();
  const resp = await fetch(`${BASE}/ai/sessions/messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ content }),
  });
  if (!resp.ok || !resp.body) throw new Error(`SSE ${resp.status}`);

  const reader = resp.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  const ev = { intent: '', stages: [], retrieve: 0, web: 0, graph: 0, memory: 0, answer: '', sources: [] };

  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const frames = buf.split('\n\n');
    buf = frames.pop() ?? '';
    for (const f of frames) {
      const line = f.split('\n').find((l) => l.startsWith('data:'));
      if (!line) continue;
      let p;
      try {
        p = JSON.parse(line.slice(5).trim());
      } catch {
        continue;
      }
      const d = p.data ?? {};
      if (p.type === 'data-plan') ev.intent = d.intent ?? '';
      else if (p.type === 'data-status') ev.stages.push(d.stage ?? '');
      else if (p.type === 'data-retrieve') ev.retrieve += (d.items ?? []).length;
      else if (p.type === 'data-web-search') ev.web += (d.results ?? []).length;
      else if (p.type === 'data-graph') ev.graph += (d.relations ?? []).length;
      else if (p.type === 'data-memory') ev.memory += (d.memories ?? []).length;
      else if (p.type === 'text-delta') ev.answer += d.delta ?? '';
      else if (p.type === 'data-sources') ev.sources = d.sources ?? [];
      else if (p.type === 'error') ev.error = d.message ?? '';
    }
  }
  ev.ms = Date.now() - t0;
  return ev;
}

const token = await login();
console.log('✅ 登录成功\n');
const summary = [];
for (const { tag, q } of QUESTIONS) {
  process.stdout.write(`${tag} … `);
  try {
    const e = await ask(token, q);
    summary.push({ tag, q, ...e });
    console.log(
      `intent=${e.intent || '(未收到)'}  检索命中=${e.retrieve}  联网=${e.web}  图谱关系=${e.graph}  记忆=${e.memory}  ` +
        `答案=${e.answer.length}字  来源=${e.sources.length}  耗时=${(e.ms / 1000).toFixed(1)}s${e.error ? '  ⚠ ' + e.error : ''}`,
    );
    console.log(`   stages: ${[...new Set(e.stages)].join(' → ')}`);
    console.log(`   答案首行: ${e.answer.replace(/\s+/g, ' ').slice(0, 90)}`);
  } catch (err) {
    console.log(`❌ ${err.message}`);
    summary.push({ tag, q, error: err.message });
  }
  console.log('');
}

const ok = summary.filter((s) => s.intent === 'knowledge').length;
console.log('─'.repeat(60));
console.log('意图分布:');
for (const s of summary) console.log(`  ${s.tag.padEnd(22)} → ${s.intent || s.error || '?'}`);
console.log('─'.repeat(60));
console.log('期望: Q1=knowledge, Q2=web, Q3=knowledge_then_web, Q4=chitchat');
