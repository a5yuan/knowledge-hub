#!/usr/bin/env node
/**
 * s09 · Token 成本（工单 24 指标 #9）
 *
 * ## 数据从哪来
 * 生产侧采集：`ENABLE_USAGE_CAPTURE=true` 时，每轮对话在 `finish` 之前多发一个
 * `usage` SSE 事件，带本轮各环节的 token 用量（见 `src/observability/tracing.service.ts`）。
 * 本脚本只负责「收事件 → 按环节汇总 → 按单价折算」，不再另算一遍用量。
 *
 * ## 两个口径必须分开
 * - **实测**：plan / grade / answer / suggestions —— 接口回的 `usage_metadata`
 * - **估算**：embedding / rerank —— DashScope 这两个接口不回 usage，按字符数估（`estimated: true`）
 *
 * 合并成一个「总 token 数」是错的：估算值可能偏 2 倍，混进去会让「最贵环节」这个结论失真。
 * 所以报告里分两列，折算金额也只对实测部分给精确值、估算部分标「估」。
 *
 * ## 单价
 * 不硬编码，读 `PRICE_INPUT_PER_1K` / `PRICE_OUTPUT_PER_1K` / `PRICE_CURRENCY`。
 * 报价会变，写死的成本数字三个月就过期。报告里必须写明单价的来源与日期。
 *
 * 用法：
 *   ENABLE_USAGE_CAPTURE=true 启动后端，然后
 *   EVAL_PASSWORD=xxx node test/eval/suite/s09-cost.mjs
 */
import { login, sseStream, summarizeTurn, probeRerank, EVAL_TEMPERATURE } from '../lib/base.mjs';
import { resolveSuiteDir, writeItemJson, writeItemLog } from '../lib/report.mjs';

/** 成本占比用的单价（每 1K token） */
const PRICE_IN = Number(process.env.PRICE_INPUT_PER_1K ?? 0.0008);
const PRICE_OUT = Number(process.env.PRICE_OUTPUT_PER_1K ?? 0.002);
const CURRENCY = process.env.PRICE_CURRENCY ?? 'CNY';

/**
 * 5 条不同意图的用例：成本结构按意图差异很大，
 * 只用知识库问答会把「闲聊为什么也要 3 秒」这类反常识的结果藏掉。
 */
const CASES = [
  { q: '加班餐补一个月最多能领多少？', expect: 'knowledge' },
  { q: '年假没休完可以顺延到明年吗？', expect: 'knowledge' },
  { q: '出差住宿标准是多少，超标了怎么报销？', expect: 'knowledge' },
  { q: '你好，随便聊两句', expect: 'chitchat' },
  { q: '最新的 AI 行业融资新闻有哪些？', expect: 'web 或 knowledge_then_web' },
];

/** 环节中文名（报告给人看，不用英文 stage 直接当标题） */
const STAGE_LABEL = {
  plan: '意图路由 plan',
  grade: '切题评估 grade',
  answer: '主回答 answer',
  suggestions: '推荐追问 suggestions',
  memory: '记忆抽取 memory',
  embedding: '向量化 embedding',
  rerank: '重排 rerank',
};

/** 金额折算（只对单一环节，调用方自行决定是否计入估算部分） */
function costOf(inputTokens, outputTokens) {
  return (inputTokens / 1000) * PRICE_IN + (outputTokens / 1000) * PRICE_OUT;
}

function fmtCost(v) {
  if (v === 0) return '0';
  return v < 0.0001 ? v.toExponential(2) : v.toFixed(4);
}

async function main() {
  const suiteDir = resolveSuiteDir();

  console.log('s09 · Token 成本（生产侧采集）');
  console.log('='.repeat(70));

  const token = await login();

  // rerank 额度直接影响成本结构：403 时请求虽发出但被拒，「rerank 花了多少」不能当真实消耗
  const rerank = await probeRerank();
  if (!rerank.ok) {
    console.log(
      `  ⚠️ Rerank 不可用（HTTP ${rerank.status}）：本次 rerank 的 token 是「请求已发出被拒」，不是真实计费`,
    );
  }

  const turns = [];
  const logLines = [];

  for (const [i, c] of CASES.entries()) {
    process.stdout.write(`  [${i + 1}/${CASES.length}] ${c.q.slice(0, 24)} … `);
    const r = await sseStream(token, { content: c.q, temperature: EVAL_TEMPERATURE });
    const s = summarizeTurn(r.events, r.wall_ms);
    const usageEvt = r.events.filter((e) => e.type === 'usage').at(-1);
    const entries = Array.isArray(usageEvt?.data?.entries)
      ? usageEvt.data.entries
      : [];
    const answer = s.answer ?? '';

    turns.push({
      question: c.q,
      expect_intent: c.expect,
      intent: s.intent ?? null,
      wall_ms: r.wall_ms,
      answer_len: answer.trim().length,
      entries,
      usage_event: !!usageEvt,
    });

    logLines.push(
      `### ${c.q}\n意图=${s.intent ?? '?'} 用时=${(r.wall_ms / 1000).toFixed(1)}s ` +
        `答案=${answer.trim().length}字 usage条目=${entries.length}\n` +
        (entries.length
          ? entries
              .map(
                (e) =>
                  `  - ${e.stage} ${e.model || '-'} in=${e.input_tokens} out=${e.output_tokens}` +
                  (e.estimated ? ' (估)' : ''),
              )
              .join('\n')
          : '  （无 usage 条目）'),
    );

    console.log(
      `${(r.wall_ms / 1000).toFixed(1)}s　usage ${entries.length} 条　答案 ${answer.trim().length} 字`,
    );
  }

  // ── 采集开关没开：这是 skip，不是 fail ──────────────────────────
  const turnsWithUsage = turns.filter((t) => t.usage_event).length;
  if (turnsWithUsage === 0) {
    console.log('-'.repeat(70));
    console.log('  ⏭ 后端没有下发 usage 事件 —— ENABLE_USAGE_CAPTURE 未开启');
    console.log('     处置：在 .env 加 ENABLE_USAGE_CAPTURE=true 后重启后端再跑');
    const payload = {
      id: 's09',
      name: 'Token 成本',
      status: 'skip',
      metric: '—',
      target: '给出「环节 × token × 成本」三列表，并指出最贵环节',
      conclusion:
        '未采集到 usage：后端 ENABLE_USAGE_CAPTURE 未开启（这是配置问题，不是指标失败）',
      turns,
      caveats: [
        'ENABLE_USAGE_CAPTURE=false 时不应下发 usage 事件 —— 这正是验收标准 #7 要的行为',
      ],
    };
    writeItemJson(suiteDir, 's09-cost', payload);
    console.log(`明细：${suiteDir}`);
    process.exitCode = 2;
    return;
  }

  // ── 按环节聚合 ────────────────────────────────────────────────
  const byStage = new Map();
  for (const t of turns) {
    for (const e of t.entries) {
      const cur =
        byStage.get(e.stage) ??
        { stage: e.stage, calls: 0, input: 0, output: 0, estimated: false, models: new Set() };
      cur.calls += 1;
      cur.input += e.input_tokens;
      cur.output += e.output_tokens;
      cur.estimated = cur.estimated || e.estimated === true;
      if (e.model) cur.models.add(e.model);
      byStage.set(e.stage, cur);
    }
  }

  const rows = [...byStage.values()]
    .map((s) => ({
      stage: s.stage,
      label: STAGE_LABEL[s.stage] ?? s.stage,
      calls: s.calls,
      input_tokens: s.input,
      output_tokens: s.output,
      total_tokens: s.input + s.output,
      estimated: s.estimated,
      /** rerank 返回 403 时，这次请求被拒 —— token 不能算作真实消耗 */
      billed: !(s.stage === 'rerank' && !rerank.ok),
      models: [...s.models],
      cost: costOf(s.input, s.output),
    }))
    .sort((a, b) => b.total_tokens - a.total_tokens);

  const measured = rows.filter((r) => !r.estimated);
  const estimatedRows = rows.filter((r) => r.estimated);
  const measuredTokens = measured.reduce((s, r) => s + r.total_tokens, 0);
  const measuredCost = measured.reduce((s, r) => s + r.cost, 0);
  const estimatedTokens = estimatedRows.reduce((s, r) => s + r.total_tokens, 0);
  const estimatedCost = estimatedRows.reduce((s, r) => s + r.cost, 0);
  const perTurnCost = turns.length ? (measuredCost + estimatedCost) / turns.length : 0;
  const mostExpensive = measured[0] ?? rows[0] ?? null;
  /** 估算里最大的那一项（可能比实测最大的还大，但口径不同，不能直接比排名） */
  const biggestEstimated = estimatedRows[0] ?? null;

  // 逐轮总用量（用来看「多轮检索到底贵多少」）
  const perTurnTokens = turns.map((t) => ({
    question: t.question,
    intent: t.intent,
    tokens: t.entries.reduce((s, e) => s + e.input_tokens + e.output_tokens, 0),
    wall_ms: t.wall_ms,
  }));

  console.log('-'.repeat(70));
  console.log('环节           调用  输入tok  输出tok   合计    折算');
  for (const r of rows) {
    console.log(
      `${r.label.padEnd(16)}${String(r.calls).padStart(3)}  ${String(r.input_tokens).padStart(7)}` +
        `  ${String(r.output_tokens).padStart(7)}  ${String(r.total_tokens).padStart(6)}` +
        `   ${fmtCost(r.cost)} ${CURRENCY}${r.estimated ? '（估）' : ''}`,
    );
  }
  console.log('-'.repeat(70));
  console.log(
    `实测合计 ${measuredTokens} tok / ${fmtCost(measuredCost)} ${CURRENCY}　` +
      `估算合计 ${estimatedTokens} tok / ${fmtCost(estimatedCost)} ${CURRENCY}（估）`,
  );
  console.log(
    `单轮均值 ${fmtCost(perTurnCost)} ${CURRENCY}　最贵环节：${mostExpensive?.label ?? '—'}`,
  );

  const payload = {
    id: 's09',
    name: 'Token 成本',
    status: 'pass',
    metric: `${fmtCost(perTurnCost)} ${CURRENCY}/轮（实测 ${fmtCost(measuredCost)} + 估算 ${fmtCost(estimatedCost)}，n=${turns.length}）`,
    target: '给出「环节 × token × 成本」三列表，并指出最贵环节',
    conclusion: `最贵环节是「${mostExpensive?.label ?? '—'}」，占实测 token 的 ${
      measuredTokens ? ((mostExpensive?.total_tokens ?? 0) / measuredTokens * 100).toFixed(1) : '0'
    }%；单轮成本 ${fmtCost(perTurnCost)} ${CURRENCY}` +
      (biggestEstimated
        ? `。估算口径里最大的是「${biggestEstimated.label}」（${biggestEstimated.total_tokens} tok，${fmtCost(biggestEstimated.cost)} ${CURRENCY}）` +
          (rerank.ok ? '' : '—— 但本次 rerank 返回 403，该数字不代表真实计费')
        : ''),
    rerank_health: {
      ok: rerank.ok,
      status: rerank.status,
      model: rerank.model,
      detail: rerank.detail,
      note: rerank.ok
        ? 'rerank 正常，估算的 token 口径可信'
        : 'rerank 请求被拒（额度/凭据），rerank 的 token 与成本不能当作真实消耗',
    },
    price: {
      input_per_1k: PRICE_IN,
      output_per_1k: PRICE_OUT,
      currency: CURRENCY,
      note: '单价来自环境变量 / .env.example 示例值，非厂商实价；成本绝对值仅供内部横向比较',
      captured_at: new Date().toISOString().slice(0, 10),
    },
    stages: rows,
    totals: {
      measured_tokens: measuredTokens,
      measured_cost: measuredCost,
      estimated_tokens: estimatedTokens,
      estimated_cost: estimatedCost,
      per_turn_cost: perTurnCost,
    },
    per_turn: perTurnTokens,
    turns,
    caveats: [
      'embedding 的 token 是按字符数估算（1.5 字符/token，中文口径），不是接口返回值；与实测值不可混算',
      'rerank 读的是接口真实返回的 usage.total_tokens（2026-10-21 实测该接口会回 usage）；只有换到不回 usage 的端点时才会退化为估算',
      '单价读自环境变量，属示例值而非厂商实价 —— 成本绝对值只能内部横向比较，不能对外引用',
      'memory（Mem0 事实抽取）在响应结束后异步执行，不进 usage 事件；若在日志里看到该环节，属另一路径',
      'rewrite 环节没有独立 token：改写是主模型的一次工具调用，计入 answer 步骤',
      ...(rerank.ok
        ? []
        : [
            `本次 rerank 不可用（HTTP ${rerank.status}）：检索链路跑在 RRF 降级模式，rerank 行的 token 是「请求发出但被拒」，不计费，也不能用来判断 rerank 贵不贵`,
          ]),
    ],
  };
  writeItemJson(suiteDir, 's09-cost', payload);
  writeItemLog(suiteDir, 's09-cost', logLines.join('\n\n'));

  console.log('='.repeat(70));
  console.log(`结论：${payload.conclusion}`);
  console.log(`明细：${suiteDir}`);
}

main().catch((err) => {
  console.error('s09 执行失败:', err);
  process.exitCode = 1;
});
