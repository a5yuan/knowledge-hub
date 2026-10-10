#!/usr/bin/env node
/**
 * Agent 多轮 trace 探针（补「方案对比卡 · 卡 3」的证据缺口）
 *
 * 卡 3 缺三样东西，全部只能靠真实调用才能拿到：
 *   1. 一笔真实的多轮 trace（几轮、调了哪些工具、为什么停）
 *   2. 预算耗尽时「强制收束」的实际效果
 *   3. 意图路由分错的真实案例
 *
 * 本脚本直接打生产入口 POST /ai/sessions/messages（手写 SSE），把 SSE 事件流
 * 还原成「每轮调了哪些工具、循环了几步、预算是否耗尽、最终是否强制收束」。
 *
 * 事件 → 事实的映射（源码 src/ai/ai-agent.service.ts）：
 *   data-plan          阶段1 五类意图路由结果（intent / suggestedTerms）
 *   data-status        阶段进度；stage=plan/grade/retrieve/web/graph/rewrite
 *   data-retrieve      retrieve_knowledge 真的执行了（一次 = 一次工具调用）
 *   data-graph         retrieve_graph 真的执行了（降级不下发）
 *   data-web-search    web_search 真的执行了
 *   start-step         Agent 循环第 N 步（N 越大说明工具调用轮次越多）
 *   data-sources       最终进入 [n] 编号引用的来源
 *   text-delta         最终回答增量（拼起来 = 答案全文）
 *
 * 用法：node test/eval/agent-trace.mjs
 * 可选环境变量：
 *   EVAL_BASE_URL  默认 http://localhost:3000
 *   AGENT_OUT      markdown 落盘路径（默认 test/eval/results/agent-trace.md）
 *   AGENT_JSON     json 落盘路径
 *
 * 前置：后端已启动；ES / Neo4j / 模型 API 可达。
 */

import 'dotenv/config';
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const BASE = process.env.EVAL_BASE_URL ?? 'http://localhost:3000';
const USERNAME = process.env.EVAL_USERNAME ?? 'admin';
const PASSWORD = process.env.EVAL_PASSWORD ?? '123456';
const HERE = dirname(fileURLToPath(import.meta.url));
const OUT_MD = process.env.AGENT_OUT ?? join(HERE, 'results', 'agent-trace.md');
const OUT_JSON = process.env.AGENT_JSON ?? join(HERE, 'results', 'agent-trace.json');

/** 硬上限（与源码常量对齐，用于判定「是否被预算/循环上限截断」） */
const MAX_ITERATIONS = 5;
const MAX_TOOL_CALLS = 4;
const MAX_REWRITE_CALLS = 1;
const MAX_WEB_CALLS = 1;
const MAX_GRAPH_CALLS = 1;

/**
 * 会话编排：
 *  A/B 是多轮会话（验证「几轮、为什么停」），C 是一批单轮会话（隔离验证意图路由）。
 *  D 是刻意构造的预算压力用例（一句话塞多个子问题 + 一个不存在的主题）。
 */
const CONVERSATIONS = [
  {
    name: 'A · 多轮：闲聊 → 制度知识 → 追问归属',
    kind: 'multi',
    turns: [
      '你好，你是谁？',
      '加班餐补一个月最多能领多少钱？',
      '那这个补贴是哪个部门负责发放的？',
    ],
  },
  {
    name: 'B · 多轮：知识 → 关系 → 联网兜底',
    kind: 'multi',
    turns: [
      '新员工入职需要准备哪些材料？',
      '王工在项目立项流程里负责什么？',
      '最近有没有关于钢铁行业数字化转型的公开新闻？',
    ],
  },
  {
    name: 'C1 · 单轮：纯闲聊（应 chitchat，零工具）',
    kind: 'single',
    turns: ['今天心情不错，随便聊两句'],
  },
  {
    name: 'C2 · 单轮：制度知识（应 knowledge + retrieve_knowledge）',
    kind: 'single',
    turns: ['公司加班有没有餐补？'],
  },
  {
    name: 'C3 · 单轮：关系型问法但**不提实体名**（图谱子串匹配的边界）',
    kind: 'single',
    turns: ['项目立项的时候技术这块谁来评估？'],
  },
  {
    name: 'C4 · 单轮：连知识库肯定没有的内容（应走联网 or 明确告知无结果）',
    kind: 'single',
    turns: ['2026 年诺贝尔物理学奖颁给了谁？'],
  },
  {
    name: 'D · 单轮：预算压力（一句话四个子问题 + 一个不存在主题）',
    kind: 'single',
    turns: [
      '请分别说明：1) 加班餐补标准；2) 法定节假日加班工资怎么算；3) 数据安全里的权限分级；4) 连铸结晶器保护渣的理化指标；另外顺便查一下「量子对撞机维护规程」是怎么规定的。',
    ],
  },
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

/** 打一次 SSE，返回完整事件数组 */
async function streamTurn(token, { sessionId, content }) {
  const t0 = Date.now();
  const res = await fetch(`${BASE}/ai/sessions/messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ content, ...(sessionId ? { sessionId } : {}) }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`SSE ${res.status}: ${text.slice(0, 200)}`);
  }
  const events = [];
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n\n')) >= 0) {
      const raw = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      for (const line of raw.split('\n')) {
        if (!line.startsWith('data: ')) continue;
        try {
          events.push(JSON.parse(line.slice(6)));
        } catch {
          /* 忽略非 JSON 片段 */
        }
      }
    }
  }
  return { events, wall_ms: Date.now() - t0 };
}

/** 把一轮事件流还原成结构化事实 */
function summarizeTurn(events, wallMs) {
  const pick = (type) => events.filter((e) => e.type === type);
  const plan = pick('data-plan').at(-1)?.data ?? null;
  const session = pick('data-session').at(-1)?.data?.sessionId ?? null;

  // 工具执行事实：三路 data-* 事件各计一次
  const retrieves = pick('data-retrieve');
  const graphs = pick('data-graph');
  const webs = pick('data-web-search');
  // rewrite_query 无独立 data-* 事件，用 data-status 的 stage 判定
  const rewriteStages = pick('data-status').filter(
    (e) => e.data?.stage === 'rewrite',
  );

  const steps = pick('start-step').map((e) => e.data?.step).filter(Boolean);
  const answer = pick('text-delta')
    .map((e) => e.data?.delta ?? '')
    .join('');
  const sources = pick('data-sources').at(-1)?.data ?? null;
  const errors = pick('error').map((e) => e.data);
  const statusStages = [
    ...new Set(pick('data-status').map((e) => e.data?.stage)),
  ].filter(Boolean);

  const toolCalls =
    retrieves.length + graphs.length + webs.length + rewriteStages.length;

  return {
    session_id: session,
    intent: plan?.intent ?? null,
    suggested_terms: plan?.suggestedTerms ?? [],
    steps: steps.length,
    step_seq: steps,
    tool_calls: toolCalls,
    tools: {
      retrieve_knowledge: retrieves.length,
      retrieve_graph: graphs.length,
      web_search: webs.length,
      rewrite_query: rewriteStages.length,
    },
    // 预算耗尽判定：实际工具调用数触到总预算上限
    budget_exhausted: toolCalls >= MAX_TOOL_CALLS,
    // 被代码强制收束的痕迹（工单 11/12：门控或预算拦截后仍回 ToolMessage）
    forced_collapse: toolCalls >= MAX_TOOL_CALLS,
    retrieved_docs: [
      ...new Set(retrieves.flatMap((e) => (e.data?.items ?? []).map((i) => i.documentTitle))),
    ],
    graph: graphs.map((e) => ({
      query: e.data?.query,
      entities: (e.data?.entities ?? []).map((x) => x.name),
      relations: (e.data?.relations ?? []).map(
        (r) => `${r.source} -${r.relation}-> ${r.target}`,
      ),
    })),
    web: webs.flatMap((e) => (e.data?.results ?? []).map((r) => r.title)),
    sources_count: Array.isArray(sources?.sources)
      ? sources.sources.length
      : Array.isArray(sources)
        ? sources.length
        : null,
    status_stages: statusStages,
    errors,
    answer_len: answer.length,
    answer,
    wall_ms: wallMs,
  };
}

async function main() {
  const token = await login();
  console.log('登录成功，开始跑 Agent trace...\n');

  const report = { base: BASE, started_at: new Date().toISOString(), conversations: [] };

  for (const conv of CONVERSATIONS) {
    console.log(`\n=== ${conv.name} ===`);
    const turns = [];
    let sessionId = null;
    for (let i = 0; i < conv.turns.length; i++) {
      const q = conv.turns[i];
      try {
        const { events, wall_ms } = await streamTurn(token, {
          sessionId,
          content: q,
        });
        const s = summarizeTurn(events, wall_ms);
        if (!sessionId && s.session_id) sessionId = s.session_id;
        turns.push({ question: q, ...s });
        console.log(
          `  [${i + 1}] intent=${s.intent} steps=${s.steps} tools=${s.tool_calls}` +
            ` (kb=${s.tools.retrieve_knowledge} graph=${s.tools.retrieve_graph}` +
            ` web=${s.tools.web_search} rewrite=${s.tools.rewrite_query})` +
            ` budget=${s.budget_exhausted ? 'EXHAUSTED' : 'ok'} ${s.wall_ms}ms`,
        );
      } catch (err) {
        turns.push({ question: q, error: msg(err) });
        console.log(`  [${i + 1}] ERROR ${msg(err)}`);
      }
    }
    report.conversations.push({ name: conv.name, kind: conv.kind, turns });
  }

  report.finished_at = new Date().toISOString();

  // ---- 落盘 markdown ----
  const lines = [];
  lines.push('# Agent 多轮 trace 探针结果（卡 3 证据补齐）');
  lines.push('');
  lines.push(`- 采集时间：${report.started_at}`);
  lines.push(`- 被测入口：\`POST ${BASE}/ai/sessions/messages\`（手写 SSE，UIMessage 形状事件）`);
  lines.push(`- 硬上限（源码常量）：\`MAX_ITERATIONS=${MAX_ITERATIONS}\`、\`MAX_TOOL_CALLS=${MAX_TOOL_CALLS}\`（各工具每轮 ≤1）`);
  lines.push('- 判定口径：`steps`=收到的 `start-step` 数（Agent 循环步数）；`tool_calls`=实际下发的 `data-retrieve`+`data-graph`+`data-web-search`+`stage=rewrite` 计数；`budget_exhausted`=工具调用数触到 4 上限；`wall_ms`=客户端端到端（含多轮模型往返）');
  lines.push('');
  lines.push('## 会话总览');
  lines.push('');
  lines.push('| 会话 | 轮 | 问题 | 意图 | 循环步数 | 工具调用 | kb | graph | web | rewrite | 预算 | 延迟 ms |');
  lines.push('| :-- | :-: | :-- | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: | ---: |');
  for (const c of report.conversations) {
    for (const [i, t] of c.turns.entries()) {
      if (t.error) {
        lines.push(`| ${c.name} | ${i + 1} | ${t.question} | — | — | — | — | — | — | — | ERROR | — |`);
        continue;
      }
      lines.push(
        `| ${c.name} | ${i + 1} | ${t.question} | ${t.intent} | ${t.steps} | ${t.tool_calls} | ` +
          `${t.tools.retrieve_knowledge} | ${t.tools.retrieve_graph} | ${t.tools.web_search} | ` +
          `${t.tools.rewrite_query} | ${t.budget_exhausted ? '**耗尽**' : '正常'} | ${t.wall_ms} |`,
      );
    }
  }
  lines.push('');
  lines.push('## 逐轮明细');
  lines.push('');
  for (const c of report.conversations) {
    lines.push(`### ${c.name}`);
    lines.push('');
    for (const [i, t] of c.turns.entries()) {
      lines.push(`#### 第 ${i + 1} 轮　${t.question}`);
      lines.push('');
      if (t.error) {
        lines.push(`- ❌ 请求失败：${t.error}`);
        lines.push('');
        continue;
      }
      lines.push(`- 意图：\`${t.intent}\`　建议检索词：${t.suggested_terms.join(' / ') || '（无）'}`);
      lines.push(
        `- 循环步数：${t.steps}（序列 ${t.step_seq.join('→')}）；工具调用共 ${t.tool_calls} 次 ` +
          `→ kb=${t.tools.retrieve_knowledge} / graph=${t.tools.retrieve_graph} / web=${t.tools.web_search} / rewrite=${t.tools.rewrite_query}`,
      );
      lines.push(`- 状态阶段：${t.status_stages.join(' → ') || '（无）'}`);
      lines.push(`- 预算：${t.budget_exhausted ? '⚠️ 触及 4 次上限（强制收束）' : '未触顶'}`);
      if (t.retrieved_docs.length) {
        lines.push(`- 命中文档：${t.retrieved_docs.join(' / ')}`);
      }
      if (t.graph.length) {
        for (const g of t.graph) {
          lines.push(`- 图谱调用 \`${g.query}\`：实体 ${g.entities.join('、') || '（空）'}；关系 ${g.relations.join('；') || '（空）'}`);
        }
      }
      if (t.web.length) {
        lines.push(`- 联网命中：${t.web.join(' / ')}`);
      }
      if (t.sources_count != null) lines.push(`- 最终引用来源数：${t.sources_count}`);
      lines.push(`- 回答长度：${t.answer_len} 字，端到端 ${t.wall_ms}ms`);
      lines.push('');
      lines.push(`<details><summary>回答全文</summary>`);
      lines.push('');
      lines.push(t.answer.slice(0, 2000) || '（空）');
      lines.push('');
      lines.push('</details>');
      lines.push('');
    }
  }

  mkdirSync(dirname(OUT_MD), { recursive: true });
  writeFileSync(OUT_MD, lines.join('\n'), 'utf8');
  writeFileSync(OUT_JSON, JSON.stringify(report, null, 2), 'utf8');
  console.log(`\n✅ 已写入 ${OUT_MD}`);
  console.log(`✅ 已写入 ${OUT_JSON}`);
}

main().catch((err) => {
  console.error('探针失败：', msg(err));
  process.exit(1);
});
