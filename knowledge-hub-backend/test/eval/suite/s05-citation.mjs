#!/usr/bin/env node
/**
 * s05 · 引用正确率（工单 24 指标 #5）
 *
 * 两个子指标，**分开报，不合并**（工单明确要求）：
 *
 * ① **编号有效性**（纯代码，硬指标 = 1.0）
 *    答案里出现的每个 `[n]` / `[Wn]` 是否落在 `data-sources` 的编号集合内。
 *    为什么不是恒真：`filterCitedSources()` 只把「被引用的来源」下发，
 *    模型若编出一个不存在的 `[9]`（实际只有 5 条来源），9 不会出现在 sources 里 —— 这就是无效引用。
 *
 * ② **支撑性**（LLM judge + 人工抽检 10 条，目标 ≥ 0.9）
 *    `[n]` 指向的片段是否真的支持那句话。
 *    judge 只判「给定这句话和这段原文，原文是否支持这句话」，不判文风、不判完整性。
 *
 * ## 为什么必须两个分开
 * 编号有效但内容不支持，是最常见的「假引用」：格式完全合法，读者点进去却发现文不对题。
 * 合并成一个「引用正确率」会把这类问题平均掉。
 *
 * 用法：
 *   EVAL_PASSWORD=xxx node test/eval/suite/s05-citation.mjs
 *   S05_MAX_PER_TURN=3        每条用例最多判几个引用（默认 3，控制 judge 开销）
 */
import 'dotenv/config';
import { login, sseStream, summarizeTurn } from '../lib/base.mjs';
import { createSuiteDir, writeItemJson, writeItemLog } from '../lib/report.mjs';

const JUDGE_MODEL = process.env.MEMORY_LLM_MODEL ?? 'qwen-plus';
const JUDGE_BASE = process.env.EMBEDDING_BASE_URL ?? '';
const JUDGE_KEY = process.env.OPENAI_API_KEY ?? '';
const MAX_PER_TURN = Number(process.env.S05_MAX_PER_TURN ?? 3);
const SUPPORT_TARGET = 0.9;

/** 会产生引用的知识库问题（闲聊/联网问题的引用口径不同，不混进来） */
const CASES = [
  '加班餐补一个月最多能领多少？',
  '年假没休完可以顺延到明年吗？',
  '出差住宿标准是多少，超标了怎么报销？',
  '请假需要提前几天申请，审批流程是什么？',
  '公司的信息安全保密要求有哪些？',
  '试用期有多长，转正需要什么条件？',
];

/** 从答案里抽出所有引用标记：数字 [n] 与 web 局部 [Wn] */
function extractMarkers(answer) {
  const numeric = [...answer.matchAll(/\[(\d{1,3})\]/g)].map((m) => ({
    raw: m[0],
    n: Number(m[1]),
    kind: 'numeric',
  }));
  const web = [...answer.matchAll(/\[W(\d{1,2})\]/gi)].map((m) => ({
    raw: m[0],
    n: Number(m[1]),
    kind: 'web',
  }));
  return [...numeric, ...web];
}

/** 把答案切成句子（保留引用标记），只留有标记的句子 */
function sentencesWithMarkers(answer) {
  return answer
    .split(/(?<=[。！？!?\n])/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && /\[(?:\d{1,3}|W\d{1,2})\]/i.test(s));
}

/** 一次非流式 judge 调用（DashScope compatible-mode） */
async function judge(question, sentence, excerpt) {
  const res = await fetch(`${JUDGE_BASE}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${JUDGE_KEY}`,
    },
    body: JSON.stringify({
      model: JUDGE_MODEL,
      temperature: 0,
      messages: [
        {
          role: 'system',
          content:
            '你是引用支撑性判定器。给定「问题」「回答中的一句话」「被引用的原文片段」，' +
            '只判断原文片段是否支持这句话。只输出 JSON：{"verdict":"supported|partial|unsupported","reason":"20字内"}。\n' +
            '- supported：原文能直接推出这句话\n' +
            '- partial：原文只支持一部分，或需要额外推断\n' +
            '- unsupported：原文与该句无关，或说的不是同一件事\n' +
            '不要因为「原文有相关信息但不够完整」就判 supported。只输出 JSON。',
        },
        {
          role: 'user',
          content: `问题：${question}\n\n句子：${sentence.slice(0, 300)}\n\n原文片段：${excerpt.slice(0, 500)}`,
        },
      ],
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`judge HTTP ${res.status}: ${body.slice(0, 200)}`);
  }
  const data = await res.json();
  const raw = data?.choices?.[0]?.message?.content ?? '';
  const m = String(raw).match(/\{[\s\S]*\}/);
  if (!m) return { verdict: 'unknown', reason: 'judge 输出无法解析' };
  try {
    const j = JSON.parse(m[0]);
    return {
      verdict: ['supported', 'partial', 'unsupported'].includes(j.verdict)
        ? j.verdict
        : 'unknown',
      reason: typeof j.reason === 'string' ? j.reason : '',
    };
  } catch {
    return { verdict: 'unknown', reason: 'judge JSON 解析失败' };
  }
}

async function main() {
  const suiteDir = process.env.SUITE_DIR ?? createSuiteDir();

  console.log('s05 · 引用正确率（编号有效性 + 支撑性）');
  console.log('='.repeat(70));

  if (!JUDGE_BASE || !JUDGE_KEY) {
    console.log('  ❌ 缺少 EMBEDDING_BASE_URL / OPENAI_API_KEY，无法调 judge');
    process.exitCode = 2;
    return;
  }

  const token = await login();

  const turns = [];
  const citations = []; // 逐条引用记录（有效性 + 支撑性）
  const logLines = [];

  for (const [i, q] of CASES.entries()) {
    process.stdout.write(`  [${i + 1}/${CASES.length}] ${q.slice(0, 20)} … `);
    const r = await sseStream(token, { content: q });
    const s = summarizeTurn(r.events, r.wall_ms);
    const sources = Array.isArray(s.sources) ? s.sources : [];
    const sourceByIndex = new Map(sources.map((x) => [x.index, x]));
    const markers = extractMarkers(s.answer);

    /**
     * 支撑性判定必须用**完整片段**，不能用 `data-sources[].excerpt`
     * —— 那个字段是 `EXCERPT_LEN=120` 截断过的，judge 只看到前 120 字，
     * 会系统性判「原文未提及」（2026-10-21 第一版就踩了这个：支撑性假性 42.9%）。
     * 完整 content 在 `data-retrieve` 的 items 里，按 documentId 取**第一条**，
     * 与 `registerSource()` 的去重口径一致（同 doc 只登记首个 chunk）。
     */
    const chunkByDoc = new Map();
    for (const evt of r.events) {
      if (evt.type !== 'data-retrieve') continue;
      for (const it of evt.data?.items ?? []) {
        if (it?.documentId && !chunkByDoc.has(it.documentId)) {
          chunkByDoc.set(it.documentId, it.content ?? it.excerpt ?? '');
        }
      }
    }

    // web 局部序号 Wn → 第 n 条 web 来源
    const webSources = sources.filter((x) => x.kind === 'web');

    const rows = [];
    for (const mk of markers) {
      const target =
        mk.kind === 'web' ? webSources[mk.n - 1] : sourceByIndex.get(mk.n);
      rows.push({
        question: q,
        marker: mk.raw,
        kind: mk.kind,
        valid: !!target,
        source_index: target?.index ?? null,
        source_title: target?.title ?? null,
        source_kind: target?.kind ?? null,
        // 判定用完整片段；excerpt 仅作展示
        excerpt:
          (target?.ref && chunkByDoc.get(target.ref)) || target?.excerpt || '',
        excerpt_is_full: !!(target?.ref && chunkByDoc.get(target.ref)),
      });
    }

    const invalid = rows.filter((x) => !x.valid).length;
    console.log(
      `${(r.wall_ms / 1000).toFixed(1)}s　引用 ${rows.length} 处　无效 ${invalid}　来源 ${sources.length} 条`,
    );

    logLines.push(
      `### ${q}\n来源 ${sources.length} 条：${sources
        .map((x) => `[${x.index}]${x.kind === 'web' ? '(web)' : ''}${x.title ?? ''}`)
        .join(' | ')}\n` +
        (rows.length
          ? rows
              .map(
                (x) =>
                  `  ${x.marker} → ${x.valid ? `[${x.source_index}] ${x.source_title ?? ''}` : '❌ 无对应来源'}`,
              )
              .join('\n')
          : '  （本轮无引用标记）'),
    );

    turns.push({
      question: q,
      wall_ms: r.wall_ms,
      answer_len: s.answer_len,
      sources: sources.length,
      citations: rows.length,
      invalid,
    });

    // 支撑性：同一轮里最多抽 MAX_PER_TURN 条（控制 judge 开销，抽样口径写进结论）
    const judged = [];
    for (const row of rows.filter((x) => x.valid)) {
      if (judged.length >= MAX_PER_TURN) break;
      const sentence = sentencesWithMarkers(s.answer).find((line) =>
        line.includes(row.marker),
      );
      if (!sentence) continue;
      if (!row.excerpt) {
        // 无 excerpt（web/graph 来源可能没有片段）→ 无法判，标 unavailable 不计入分母
        row.verdict = 'unavailable';
        row.reason = '来源无 excerpt 片段';
        judged.push(row);
        continue;
      }
      try {
        const v = await judge(q, sentence, row.excerpt);
        row.verdict = v.verdict;
        row.reason = v.reason;
        row.sentence = sentence.slice(0, 160);
      } catch (err) {
        row.verdict = 'error';
        row.reason = err instanceof Error ? err.message : String(err);
      }
      judged.push(row);
    }
    citations.push(...rows);
  }

  // ── ① 编号有效性 ────────────────────────────────────────────
  const total = citations.length;
  const validCount = citations.filter((c) => c.valid).length;
  const validityRate = total ? validCount / total : 1;

  /**
   * 零引用 = 指标没有判别力（和 s12「1 片文档测幂等」同一类坑）：
   * 答案一条 [n] 都没有时，validity=1.0、support=1.0 全是空过。
   * 这通常意味着检索没命中、或模型没被要求标注 —— 属环境/用例问题，不是「引用完美」。
   */
  if (total === 0) {
    console.log('-'.repeat(70));
    console.log('  ⏭ 6 轮共 0 处引用标记 —— 指标无判别力，不产出通过结论');
    const payload = {
      id: 's05',
      name: '引用正确率',
      status: 'skip',
      metric: '—（0 处引用）',
      target: '编号有效性 = 100%；支撑性 ≥ 90%',
      conclusion:
        '答案里没有任何 [n] 引用标记，两项子指标都无法判定（空过不算通过）。需先确认检索命中与引用要求',
      per_turn: turns,
      caveats: ['零引用时 validity/support 会假性 100%，故判 skip 而非 pass'],
    };
    writeItemJson(suiteDir, 's05-citation', payload);
    writeItemLog(suiteDir, 's05-citation', logLines.join('\n\n'));
    console.log(`明细：${suiteDir}`);
    process.exitCode = 2;
    return;
  }

  // ── ② 支撑性 ────────────────────────────────────────────────
  const judgedRows = citations.filter(
    (c) => c.verdict && !['unavailable', 'error'].includes(c.verdict),
  );
  const supported = judgedRows.filter((c) => c.verdict === 'supported').length;
  const partial = judgedRows.filter((c) => c.verdict === 'partial').length;
  const unsupported = judgedRows.filter((c) => c.verdict === 'unsupported').length;
  // 口径：partial 不计为支持（宁严不宽）；报告里同时给「含 partial」的宽口径
  const supportRate = judgedRows.length ? supported / judgedRows.length : 1;
  const supportRateLoose = judgedRows.length
    ? (supported + partial) / judgedRows.length
    : 1;

  const validityOk = validityRate === 1;
  const supportOk = supportRate >= SUPPORT_TARGET;
  const status = validityOk && supportOk ? 'pass' : 'fail';

  const badCitations = citations
    .filter((c) => !c.valid || c.verdict === 'unsupported')
    .slice(0, 10);

  console.log('-'.repeat(70));
  console.log(
    `编号有效性 ${(validityRate * 100).toFixed(1)}%（${validCount}/${total}，目标 100%）`,
  );
  console.log(
    `支撑性     ${(supportRate * 100).toFixed(1)}%（${supported}/${judgedRows.length}，目标 ≥90%；` +
      `宽松含 partial ${(supportRateLoose * 100).toFixed(1)}%）`,
  );
  if (badCitations.length) {
    console.log('问题引用：');
    for (const c of badCitations) {
      console.log(
        `  ${c.marker} ${c.valid ? '' : '❌无来源 '}${c.verdict ?? ''} ${c.reason ?? ''}`.trim(),
      );
    }
  }

  // ── 人工抽检样本（10 条）────────────────────────────────────
  const manual = judgedRows.slice(0, 10).map((c, i) => ({
    no: i + 1,
    question: c.question,
    marker: c.marker,
    sentence: c.sentence ?? '',
    excerpt: (c.excerpt ?? '').slice(0, 300),
    judge_verdict: c.verdict,
    judge_reason: c.reason ?? '',
    /** 人工回填位：与 judge 不一致就写这里，用来校准 judge 的可信度 */
    human_verdict: '',
    human_note: '',
  }));

  const payload = {
    id: 's05',
    name: '引用正确率',
    status,
    metric: `编号有效性 ${(validityRate * 100).toFixed(1)}% / 支撑性 ${(supportRate * 100).toFixed(1)}%`,
    target: '编号有效性 = 100%（硬指标）；支撑性 ≥ 90%',
    conclusion:
      status === 'pass'
        ? `${total} 处引用编号全部有效；抽检 ${judgedRows.length} 处中 ${supported} 处被原文直接支持，无假引用`
        : `未达标：编号有效性 ${(validityRate * 100).toFixed(1)}%、支撑性 ${(supportRate * 100).toFixed(1)}%`,
    validity: { rate: validityRate, valid: validCount, total },
    supportability: {
      rate: supportRate,
      loose_rate: supportRateLoose,
      supported,
      partial,
      unsupported,
      judged: judgedRows.length,
      unavailable: citations.filter((c) => c.verdict === 'unavailable').length,
      errors: citations.filter((c) => c.verdict === 'error').length,
    },
    judge: {
      model: JUDGE_MODEL,
      base_url: JUDGE_BASE,
      temperature: 0,
      /** 抽检口径：每轮最多判 MAX_PER_TURN 条 */
      max_per_turn: MAX_PER_TURN,
    },
    per_turn: turns,
    bad_citations: badCitations,
    caveats: [
      '支撑性口径取严：partial 不计为支持，同时给出「含 partial」的宽松值，两个数都报',
      `judge 只用 ${MAX_PER_TURN} 条/轮的抽样，不是全量判定 —— 分母是抽样数，不是引用总数`,
      'web / graph 来源若没有 excerpt，判为 unavailable 并从分母剔除（judge 无原文可依）',
      '支撑性判定用 data-retrieve 里的完整 chunk —— data-sources[].excerpt 只有 120 字，拿它判会系统性误判「原文未提及」',
      `人工抽检样本 ${manual.length} 条见 s05-manual-samples.json：judge 与人工不一致时以人工为准，用来校准 judge`,
    ],
  };
  writeItemJson(suiteDir, 's05-citation', payload);
  writeItemJson(suiteDir, 's05-manual-samples', { samples: manual });
  writeItemLog(suiteDir, 's05-citation', logLines.join('\n\n'));

  console.log('='.repeat(70));
  console.log(`结论：${payload.conclusion}`);
  console.log(`人工抽检样本：${manual.length} 条（s05-manual-samples.json）`);
  console.log(`明细：${suiteDir}`);
  if (status !== 'pass') process.exitCode = 1;
}

main().catch((err) => {
  console.error('s05 执行失败:', err);
  process.exitCode = 1;
});
