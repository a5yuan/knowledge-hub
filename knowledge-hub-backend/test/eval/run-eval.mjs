#!/usr/bin/env node
/**
 * RAG 评测 runner（工单 13）
 *
 * 为什么独立成脚本而不塞进 jest：评测要求「数据集 + 可复现指标 + 回写 Langfuse」三件套，
 * 且依赖真实后端在线；与被测链路解耦后才能在被测服务未启动时做静态校验。
 *
 * 流程：登录(admin) → 逐用例 POST /ai/sessions/messages(SSE) → 解析检索/生成指标
 *       → LLM judge → 回写 Langfuse(dataset item / score / dataset-run-item) → 出报告
 *
 * 用法：node test/eval/run-eval.mjs
 * 前置：后端已启动；seed-corpus.mjs 已生成 corpus-manifest.json；Langfuse/DashScope 凭据就绪。
 */

import 'dotenv/config'; // 必须最先执行：本脚本直接读 process.env 取 DashScope / Langfuse 凭据
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { LangfuseClient } from '@langfuse/client';
import { z } from 'zod';

const BASE = process.env.EVAL_BASE_URL ?? 'http://localhost:3000';
const USERNAME = process.env.EVAL_USERNAME ?? 'admin';
const PASSWORD = process.env.EVAL_PASSWORD ?? '123456';
const RUN_NAME =
  process.env.EVAL_RUN_NAME ??
  `eval-${new Date().toISOString().replace(/:/g, '-')}`;
const DATASET_NAME = process.env.EVAL_DATASET_NAME ?? 'knowledge-hub-rag-eval';
const SKIP_JUDGE = process.env.EVAL_SKIP_JUDGE === '1';
const HERE = dirname(fileURLToPath(import.meta.url));

const LF_PUBLIC_KEY = process.env.LANGFUSE_PUBLIC_KEY;
const LF_SECRET_KEY = process.env.LANGFUSE_SECRET_KEY;
const LF_ENABLED = Boolean(LF_PUBLIC_KEY && LF_SECRET_KEY);

const judgeSchema = z.object({
  faithfulness: z.number().int().min(1).max(5),
  answer_relevancy: z.number().int().min(1).max(5),
  answer_completeness: z.number().int().min(1).max(5),
  context_utilization: z.number().int().min(1).max(5),
  reason: z.string().optional(),
});

const dataset = JSON.parse(readFileSync(join(HERE, 'dataset.json'), 'utf8'));
const K = dataset.k ?? 5;

// ────────────────────────────── 基础工具 ──────────────────────────────

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

/** 逐行解析 SSE 的 `data: {...}`；跨 chunk 断行由 buffer 兜住（最后一行留待补齐） */
async function readSse(res, onEvent) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  const handle = (line) => {
    const trimmed = line.trim();
    if (!trimmed.startsWith('data:')) return;
    const payload = trimmed.slice(5).trim();
    if (!payload || payload === '[DONE]') return;
    let evt;
    try {
      evt = JSON.parse(payload);
    } catch {
      return; // 非 JSON 的 data 行（如心跳）直接忽略
    }
    onEvent(evt);
  };
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop();
    for (const line of lines) handle(line);
  }
  if (buf) handle(buf);
}

/** 一轮对话：合并前置管线与工具内重复出现的 data-retrieve（按 documentId 保留首次出现顺序） */
async function chatOnce(token, question) {
  const res = await fetch(`${BASE}/ai/sessions/messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ content: question }),
    signal: AbortSignal.timeout(180_000),
  });
  if (!res.ok)
    throw new Error(
      `对话请求失败 ${res.status}: ${(await res.text()).slice(0, 200)}`,
    );

  const state = {
    intent: undefined,
    retrieved: [],
    seen: new Set(),
    answer: '',
    sources: [],
    traceId: undefined,
    error: undefined,
  };
  await readSse(res, (evt) => {
    const type = evt?.type;
    const data = evt?.data ?? {};
    if (type === 'data-plan') state.intent = data.intent;
    else if (type === 'data-retrieve') {
      for (const it of data.items ?? []) {
        const id = String(it.documentId);
        if (state.seen.has(id)) continue;
        state.seen.add(id);
        state.retrieved.push({
          documentId: id,
          documentTitle: it.documentTitle,
          excerpt: it.excerpt,
          // 后端 data-retrieve 现在附带完整 chunk 正文；judge 必须看全文，否则会把「120 字 excerpt 之外的事实」误判成幻觉
          content: it.content,
        });
      }
    } else if (type === 'text-delta') state.answer += data.delta ?? '';
    else if (type === 'data-sources') state.sources = data.sources ?? [];
    else if (type === 'finish') state.traceId = data.traceId;
    else if (type === 'error') state.error = data.message;
  });
  return state;
}

// ────────────────────────────── 指标计算 ──────────────────────────────

/** 标题 → docId：优先 manifest，其次用检索结果里的 documentTitle 完全一致兜底 */
function resolveExpectedDocIds(item, manifestMap, retrieved) {
  const ids = new Set();
  const unresolvedTitles = [];
  for (const title of item.expected_doc_titles ?? []) {
    let docId = manifestMap.get(title);
    if (!docId) {
      const hit = retrieved.find((r) => r.documentTitle === title);
      if (hit) docId = hit.documentId;
    }
    if (docId) ids.add(String(docId));
    else unresolvedTitles.push(title);
  }
  return { ids, unresolvedTitles };
}

function retrievalMetrics(expectedIds, retrieved) {
  const topK = retrieved.slice(0, K).map((r) => String(r.documentId));
  const hits = topK.filter((id) => expectedIds.has(id));
  const firstIdx = topK.findIndex((id) => expectedIds.has(id));
  return {
    recall_at_k: expectedIds.size > 0 ? hits.length / expectedIds.size : 0,
    precision_at_k: hits.length / K,
    mrr: firstIdx >= 0 ? 1 / (firstIdx + 1) : 0,
    hit_at_k: hits.length > 0 ? 1 : 0,
  };
}

// ────────────────────────────── LLM judge ──────────────────────────────

function contextText(retrieved) {
  if (retrieved.length === 0) return '（无检索上下文）';
  return retrieved
    .slice(0, K)
    .map(
      (r, i) =>
        `[${i + 1}] ${r.documentTitle ?? ''}\n${r.content ?? r.excerpt ?? ''}`,
    )
    .join('\n\n');
}

async function runJudge({ question, retrieved, keyPoints, answer }) {
  const base = process.env.EMBEDDING_BASE_URL;
  const key = process.env.OPENAI_API_KEY;
  if (!base) throw new Error('EMBEDDING_BASE_URL 未配置');
  if (!key) throw new Error('OPENAI_API_KEY 未配置');

  const system = '你是严格的 RAG 评测员。只输出 JSON，不要输出多余文本。';
  const user = [
    '请基于下列信息为「模型回答」打分：每个维度 1~5 的整数（5 最好）。',
    '',
    `【用户问题】${question}`,
    `【检索到的上下文】\n${contextText(retrieved)}`,
    `【期望要点】${keyPoints.length > 0 ? keyPoints.join('；') : '（无，按回答质量评判）'}`,
    `【模型回答】${answer || '（空）'}`,
    '',
    '维度说明：',
    '- faithfulness：回答的论断能否在上下文中找到依据（上下文为空给 1）',
    '- answer_relevancy：是否正面回答用户问题、不跑题',
    '- answer_completeness：覆盖期望要点的比例（无要点时按回答完整度给分）',
    '- context_utilization：上下文被实际使用的程度（上下文为空给 1）',
    '输出示例：{"faithfulness":4,"answer_relevancy":5,"answer_completeness":3,"context_utilization":4,"reason":"简短中文理由"}',
  ].join('\n');

  const res = await fetch(`${base.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${key}`,
    },
    body: JSON.stringify({
      model: process.env.EVAL_JUDGE_MODEL ?? 'qwen-plus',
      temperature: 0,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
    }),
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok)
    throw new Error(
      `judge HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`,
    );
  const json = await res.json();
  const content = json?.choices?.[0]?.message?.content;
  if (typeof content !== 'string')
    throw new Error('judge 响应缺少 choices[0].message.content');
  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new Error('judge 返回非法 JSON');
  }
  const r = judgeSchema.safeParse(parsed);
  if (!r.success) {
    throw new Error(
      `judge 校验失败: ${r.error.issues.map((i) => `${i.path.join('.')}:${i.message}`).join('; ')}`,
    );
  }
  return r.data;
}

// ────────────────────────────── Langfuse 回写 ──────────────────────────────

async function writeDatasetItem(item) {
  const created = await lf.dataset.createItem({
    datasetName: DATASET_NAME,
    id: item.id,
    input: item.question,
    expectedOutput: { key_points: item.expected_key_points ?? [] },
    metadata: {
      intent: item.intent,
      expected_doc_titles: item.expected_doc_titles ?? [],
    },
  });
  return created.id; // DatasetItem.id 即 dataset item id（用于关联 run）
}

/** 关联本次 run：把用例的 trace 挂到 dataset run（SDK 已封装 /api/public/dataset-run-items，无需手写 REST） */
async function linkDatasetRunItem({ datasetItemId, traceId }) {
  return lf.api.datasetRunItems.create({
    runName: RUN_NAME,
    datasetItemId,
    traceId,
  });
}

/** 确保数据集存在：createItem 不会自动建数据集（缺失时 404），必须先 get → 404 则 create */
async function ensureDataset() {
  try {
    await lf.api.datasets.get(DATASET_NAME);
  } catch {
    await lf.api.datasets.create({
      name: DATASET_NAME,
      description: '工单 13 RAG 评测数据集（由 test/eval/run-eval.mjs 同步）',
    });
    console.log(`已创建 Langfuse 数据集 ${DATASET_NAME}`);
  }
}

// ────────────────────────────── 报告 ──────────────────────────────

const fmt = (n, d = 3) =>
  n === null || n === undefined ? '—' : Number(n).toFixed(d);

function mdTable(headers, rows) {
  const head = `| ${headers.join(' | ')} |`;
  const sep = `| ${headers.map(() => '---').join(' | ')} |`;
  return [head, sep, ...rows.map((r) => `| ${r.join(' | ')} |`)].join('\n');
}

/** 按维度求均值，跳过 null（未评分的用例不拉低均值） */
function avg(values) {
  const nums = values.filter((v) => v !== null && v !== undefined);
  return nums.length > 0 ? nums.reduce((a, b) => a + b, 0) / nums.length : null;
}

const RETRIEVAL_METRICS = ['recall_at_k', 'precision_at_k', 'mrr', 'hit_at_k'];
const JUDGE_METRICS = [
  'faithfulness',
  'answer_relevancy',
  'answer_completeness',
  'context_utilization',
];

function buildReport({
  startedAt,
  results,
  unresolvedCases,
  judgeFailCases,
  unlinkedCases,
  noTraceCases,
}) {
  const lines = [];
  lines.push('# RAG 评测报告（工单 13）');
  lines.push('');
  lines.push(`- run name：\`${RUN_NAME}\``);
  lines.push(`- 数据集：\`${DATASET_NAME}\``);
  lines.push(`- 时间：${startedAt.toISOString()}`);
  lines.push(`- 被测 BASE：\`${BASE}\``);
  lines.push(`- K：${K}　用例数：${results.length}`);
  lines.push('');

  // 总览：每个指标在所有已评分用例上的均值
  const overviewRows = [
    ...RETRIEVAL_METRICS.map((m) => [
      m,
      fmt(avg(results.filter((r) => r.metrics).map((r) => r.metrics[m]))),
      String(results.filter((r) => r.metrics).length),
    ]),
    ...JUDGE_METRICS.map((m) => [
      m,
      fmt(avg(results.filter((r) => r.judge).map((r) => r.judge[m]))),
      String(results.filter((r) => r.judge && r.judge[m] !== null).length),
    ]),
  ];
  lines.push('## 总览（各指标均值）');
  lines.push('');
  lines.push(mdTable(['指标', '均值', '有效用例数'], overviewRows));
  lines.push('');

  // 按 intent 分组
  const intents = [...new Set(results.map((r) => r.intent ?? 'unknown'))];
  const groupRows = [];
  for (const intent of intents) {
    const group = results.filter((r) => (r.intent ?? 'unknown') === intent);
    for (const m of [...RETRIEVAL_METRICS, ...JUDGE_METRICS]) {
      const vals = group
        .map((r) => (r.metrics && m in r.metrics ? r.metrics[m] : r.judge?.[m]))
        .filter((v) => v !== undefined);
      groupRows.push([
        intent,
        m,
        fmt(avg(vals)),
        String(vals.filter((v) => v !== null && v !== undefined).length),
      ]);
    }
  }
  lines.push('## 按 intent 分组均值');
  lines.push('');
  lines.push(mdTable(['intent', '指标', '均值', '有效用例数'], groupRows));
  lines.push('');

  // 逐用例明细
  lines.push('## 逐用例明细');
  lines.push('');
  for (const r of results) {
    lines.push(`### ${r.id} · ${r.intent ?? '?'} · ${r.statusLabel}`);
    lines.push('');
    lines.push(`- 问题：${r.question}`);
    lines.push(
      `- 期望文档：${r.expectedDocTitles.length ? r.expectedDocTitles.join('、') : '（无）'}`,
    );
    lines.push(`- 意图识别：${r.actualIntent ?? '（未收到 data-plan）'}`);
    const topK = r.retrieved.slice(0, K);
    lines.push(
      `- 检索 topK：${topK.length ? topK.map((t) => `${t.documentTitle ?? '?'}(${t.documentId})`).join('、') : '（空）'}`,
    );
    lines.push(
      `- 检索指标：${r.metrics ? RETRIEVAL_METRICS.map((m) => `${m}=${fmt(r.metrics[m])}`).join('  ') : '未计算'}`,
    );
    lines.push(
      `- 生成指标：${
        r.judge
          ? JUDGE_METRICS.map((m) => `${m}=${r.judge[m] ?? '—'}`).join('  ')
          : SKIP_JUDGE
            ? '（EVAL_SKIP_JUDGE=1 已跳过）'
            : '未评分'
      }`,
    );
    if (r.judge?.reason) lines.push(`- judge 理由：${r.judge.reason}`);
    lines.push(`- 断言：${r.assertion}`);
    lines.push(`- traceId：${r.traceId ?? '（无）'}`);
    if (r.warnings.length) lines.push(`- warning：${r.warnings.join('；')}`);
    lines.push(
      `- 回答（截断 200 字）：${(r.answer || '（空）').slice(0, 200).replace(/\n/g, ' ')}`,
    );
    lines.push('');
  }

  // 显式清单：未解析 / judge 失败 / 未关联 trace
  lines.push('## 异常清单');
  lines.push('');
  lines.push('### 未解析标题（检索层指标被跳过）');
  lines.push('');
  lines.push(
    unresolvedCases.length
      ? unresolvedCases
          .map((c) => `- ${c.id}：${c.unresolvedTitles.join('、')}`)
          .join('\n')
      : '- （无）',
  );
  lines.push('');
  lines.push('### judge 失败（生成层指标全部计 null）');
  lines.push('');
  lines.push(
    judgeFailCases.length
      ? judgeFailCases.map((c) => `- ${c.id}：${c.reason}`).join('\n')
      : '- （无）',
  );
  lines.push('');
  lines.push('### 未关联 trace（dataset-run-item 回写失败）');
  lines.push('');
  lines.push(
    unlinkedCases.length
      ? unlinkedCases.map((c) => `- ${c.id}：${c.reason}`).join('\n')
      : '- （无）',
  );
  lines.push('');
  lines.push('### 无 traceId（分数回写被跳过）');
  lines.push('');
  lines.push(
    noTraceCases.length
      ? noTraceCases.map((c) => `- ${c.id}`).join('\n')
      : '- （无）',
  );
  lines.push('');

  return lines.join('\n');
}

// ────────────────────────────── 主流程 ──────────────────────────────

let lf = null;

async function main() {
  const startedAt = new Date();
  console.log(
    `== RAG 评测 ==\nrun=${RUN_NAME}  BASE=${BASE}  账号=${USERNAME}  K=${K}`,
  );
  if (LF_ENABLED) {
    lf = new LangfuseClient();
    try {
      await ensureDataset();
    } catch (err) {
      console.warn(
        `! Langfuse 数据集准备失败（dataset item 回写将失败并逐条记 warning）：${msg(err)}`,
      );
    }
  } else {
    console.warn(
      '! 未检测到 LANGFUSE_PUBLIC_KEY / LANGFUSE_SECRET_KEY，跳过全部 Langfuse 回写',
    );
  }

  const only = process.env.EVAL_ONLY
    ? new Set(
        process.env.EVAL_ONLY.split(',')
          .map((s) => s.trim())
          .filter(Boolean),
      )
    : null;
  const items = dataset.items.filter((it) => !only || only.has(it.id));
  console.log(`用例数=${items.length}${only ? `（EVAL_ONLY 过滤）` : ''}\n`);

  // corpus-manifest.json 缺失/损坏只会让「有期望文档」的用例变 unresolved，不进静默降级
  const manifestPath = join(HERE, 'corpus-manifest.json');
  const manifestMap = new Map();
  let manifestOk = false;
  if (existsSync(manifestPath)) {
    try {
      const raw = JSON.parse(readFileSync(manifestPath, 'utf8'));
      for (const d of raw.docs ?? []) manifestMap.set(d.title, String(d.docId));
      manifestOk = true;
    } catch (err) {
      console.warn(`! corpus-manifest.json 解析失败：${msg(err)}`);
    }
  } else {
    console.warn(
      `! corpus-manifest.json 不存在，含期望文档的用例将被标记 unresolved`,
    );
  }

  const token = await login();
  console.log('已登录\n');

  const results = [];
  const unresolvedCases = [];
  const judgeFailCases = [];
  const unlinkedCases = [];
  const noTraceCases = [];

  for (const item of items) {
    const r = {
      id: item.id,
      intent: item.intent,
      question: item.question,
      expectedDocTitles: item.expected_doc_titles ?? [],
      expectedIds: new Set(),
      unresolvedTitles: [],
      retrieved: [],
      actualIntent: undefined,
      answer: '',
      sources: [],
      traceId: undefined,
      metrics: null,
      judge: null,
      assertion: '',
      statusLabel: '',
      warnings: [],
    };

    let chatErr = null;
    try {
      const state = await chatOnce(token, item.question);
      r.actualIntent = state.intent;
      r.retrieved = state.retrieved;
      r.answer = state.answer;
      r.sources = state.sources;
      r.traceId = state.traceId;
      if (state.error) r.warnings.push(`SSE error 事件：${state.error}`);
    } catch (err) {
      chatErr = err;
      r.warnings.push(`对话请求失败：${msg(err)}`);
    }

    // 检索层指标：仅对有期望文档且能全部解析出 docId 的用例计算
    const hasExpected = r.expectedDocTitles.length > 0;
    if (hasExpected) {
      const { ids, unresolvedTitles } = resolveExpectedDocIds(
        item,
        manifestMap,
        r.retrieved,
      );
      r.expectedIds = ids;
      r.unresolvedTitles = unresolvedTitles;
      if (unresolvedTitles.length > 0) {
        r.statusLabel = 'unresolved';
        if (!manifestOk) r.warnings.push('corpus-manifest.json 缺失或损坏');
        unresolvedCases.push({ id: r.id, unresolvedTitles });
      } else if (!chatErr) {
        r.metrics = retrievalMetrics(ids, r.retrieved);
      } else {
        // 请求本身失败时不再按「检索到 0 条」计分，避免把链路故障伪装成 0 分
        r.warnings.push('对话请求失败，检索层指标未计算');
      }
    }

    // 行为断言：graph 是软用例，不算失败
    const isSoftGraph = item.intent === 'graph';
    if (hasExpected && r.unresolvedTitles.length === 0) {
      if (isSoftGraph) {
        r.assertion = 'skipped-soft（图谱异步抽取可能未就绪）';
        r.statusLabel = r.statusLabel || 'skipped-soft';
      }
    }

    if (item.intent === 'chitchat') {
      const ok = r.actualIntent === 'chitchat' && r.retrieved.length === 0;
      r.assertion = ok
        ? 'PASS（intent=chitchat 且无检索结果）'
        : `FAIL（intent=${r.actualIntent ?? '?'}，检索结果 ${r.retrieved.length} 条）`;
      r.statusLabel = ok ? 'PASS' : 'FAIL';
    } else if (item.intent === 'no_result') {
      const re = /未检索到|没有相关|未找到|无法回答|知识库中未|没有找到/;
      const ok = re.test(r.answer);
      r.assertion = ok ? 'PASS（命中拒答措辞）' : `FAIL（回答未命中拒答措辞）`;
      r.statusLabel = ok ? 'PASS' : 'FAIL';
    } else if (item.intent === 'web') {
      const ok =
        r.actualIntent === 'web' || r.actualIntent === 'knowledge_then_web';
      r.assertion = ok
        ? `PASS（intent=${r.actualIntent}）`
        : `FAIL（intent=${r.actualIntent ?? '?'}）`;
      r.statusLabel = ok ? 'PASS' : 'FAIL';
    } else if (isSoftGraph) {
      // graph 不断言 pass/fail，仅标注
    } else if (r.unresolvedTitles.length === 0) {
      r.assertion = 'PASS（已完成评测）';
      r.statusLabel = r.statusLabel || 'PASS';
    } else {
      r.assertion = 'N/A（unresolved，未评测）';
    }

    // 链路故障是显式失败（含 graph）：soft 只豁免「KG 未就绪」这一种情形
    if (chatErr) {
      r.assertion = `FAIL（对话请求异常：${msg(chatErr)}）`;
      r.statusLabel = 'FAIL';
    }

    // 生成层 judge
    if (!SKIP_JUDGE && !chatErr) {
      try {
        const j = await runJudge({
          question: item.question,
          retrieved: r.retrieved,
          keyPoints: item.expected_key_points ?? [],
          answer: r.answer,
        });
        // 无期望文档的用例（闲聊/无结果/联网）只保留 answer_relevancy，其余记 null 并从均值排除
        r.judge = hasExpected
          ? { ...j }
          : {
              faithfulness: null,
              answer_relevancy: j.answer_relevancy,
              answer_completeness: null,
              context_utilization: null,
              reason: j.reason,
            };
      } catch (err) {
        r.judge = {
          faithfulness: null,
          answer_relevancy: null,
          answer_completeness: null,
          context_utilization: null,
          reason: '',
        };
        judgeFailCases.push({ id: r.id, reason: msg(err) });
        r.warnings.push(`judge 失败：${msg(err)}`);
      }
    }

    // ── Langfuse 回写（每步独立 try/catch，失败只记 warning） ──
    if (LF_ENABLED && !chatErr) {
      let datasetItemId = null;
      try {
        datasetItemId = await writeDatasetItem(item);
      } catch (err) {
        r.warnings.push(`dataset item 回写失败：${msg(err)}`);
      }

      const hasTrace = Boolean(r.traceId);
      if (!hasTrace) {
        // 只对该用例记一条 warning（不按指标数重复）
        noTraceCases.push({ id: r.id });
        r.warnings.push('无 traceId，分数回写被跳过');
      } else {
        const scores = [];
        if (r.metrics)
          for (const m of RETRIEVAL_METRICS)
            scores.push({ name: m, value: r.metrics[m], comment: `topK=${K}` });
        if (r.judge) {
          for (const m of JUDGE_METRICS) {
            if (r.judge[m] !== null && r.judge[m] !== undefined) {
              scores.push({
                name: m,
                value: r.judge[m],
                comment: r.judge.reason ?? '',
              });
            }
          }
        }
        for (const s of scores) {
          try {
            lf.score.create({
              traceId: r.traceId,
              name: s.name,
              value: s.value,
              comment: s.comment,
            });
          } catch (err) {
            r.warnings.push(`score(${s.name}) 回写失败：${msg(err)}`);
          }
        }

        if (datasetItemId) {
          try {
            await linkDatasetRunItem({ datasetItemId, traceId: r.traceId });
          } catch (err) {
            unlinkedCases.push({ id: r.id, reason: msg(err) });
            r.warnings.push(`dataset-run-item 关联失败：${msg(err)}`);
          }
        } else {
          unlinkedCases.push({ id: r.id, reason: 'dataset item 未创建' });
        }
      }
    }

    results.push(r);

    // 控制台逐行
    const tag =
      r.statusLabel === 'FAIL'
        ? '✗'
        : r.statusLabel === 'unresolved'
          ? '⚠'
          : r.statusLabel === 'skipped-soft'
            ? '∘'
            : '✓';
    const metricStr = r.metrics
      ? ` R@${K}=${fmt(r.metrics.recall_at_k, 2)} P@${K}=${fmt(r.metrics.precision_at_k, 2)} MRR=${fmt(r.metrics.mrr, 2)} Hit=${r.metrics.hit_at_k}`
      : '';
    const judgeStr = r.judge
      ? ` judge[f=${r.judge.faithfulness ?? '—'} r=${r.judge.answer_relevancy ?? '—'} c=${r.judge.answer_completeness ?? '—'} u=${r.judge.context_utilization ?? '—'}]`
      : '';
    console.log(
      `${tag} ${r.id} ${r.intent} ${r.statusLabel}${metricStr}${judgeStr}`,
    );
    for (const w of r.warnings) console.warn(`    ! ${w}`);
  }

  // ── 汇总 ──
  const failedCases = results.filter((r) => r.statusLabel === 'FAIL');
  const softCases = results.filter((r) => r.statusLabel === 'skipped-soft');
  const scoredCases = results.filter((r) => r.metrics || r.judge);

  console.log('\n== 分类汇总（按 intent）==');
  const intents = [...new Set(results.map((r) => r.intent ?? 'unknown'))];
  for (const intent of intents) {
    const group = results.filter((r) => (r.intent ?? 'unknown') === intent);
    const parts = [...RETRIEVAL_METRICS, ...JUDGE_METRICS].map((m) => {
      const vals = group
        .map((r) => (r.metrics && m in r.metrics ? r.metrics[m] : r.judge?.[m]))
        .filter((v) => v !== undefined);
      return `${m}=${fmt(avg(vals), 2)}`;
    });
    console.log(`  ${intent}（${group.length}）: ${parts.join('  ')}`);
  }
  console.log('\n== 总均值 ==');
  for (const m of [...RETRIEVAL_METRICS, ...JUDGE_METRICS]) {
    const vals = results
      .map((r) => (r.metrics && m in r.metrics ? r.metrics[m] : r.judge?.[m]))
      .filter((v) => v !== undefined);
    console.log(`  ${m}=${fmt(avg(vals), 2)}`);
  }

  const summary = {
    total: results.length,
    scored: scoredCases.length,
    failed: failedCases.length,
    unresolved: unresolvedCases.length,
    skippedSoft: softCases.length,
    judgeFailed: judgeFailCases.length,
    unlinkedTrace: unlinkedCases.length,
    noTrace: noTraceCases.length,
  };
  console.log('\n== 计数 ==');
  console.log(
    `  用例 ${summary.total}　已评分 ${summary.scored}　断言失败 ${summary.failed}　未解析 ${summary.unresolved}　软跳过 ${summary.skippedSoft}　judge 失败 ${summary.judgeFailed}　未关联 trace ${summary.unlinkedTrace}　无 traceId ${summary.noTrace}`,
  );

  writeFileSync(
    join(HERE, 'eval-report.md'),
    buildReport({
      startedAt,
      results,
      unresolvedCases,
      judgeFailCases,
      unlinkedCases,
      noTraceCases,
    }),
  );
  console.log(`\n报告已写出 ${join(HERE, 'eval-report.md')}`);

  if (LF_ENABLED) {
    try {
      await lf.flush();
    } catch (err) {
      console.warn(`! Langfuse flush 失败：${msg(err)}`);
    }
  }

  // 退出码：断言失败 或 unresolved → 1；软用例(graph)不计
  const exitCode = failedCases.length > 0 || unresolvedCases.length > 0 ? 1 : 0;
  if (exitCode === 1) {
    console.error(
      `\n存在失败项（断言失败 ${failedCases.length} / 未解析 ${unresolvedCases.length}）—— exit 1`,
    );
  } else {
    console.log('\n全部通过 —— exit 0');
  }
  process.exit(exitCode);
}

main().catch((err) => {
  console.error(`评测 runner 异常：${msg(err)}`);
  process.exit(1);
});
