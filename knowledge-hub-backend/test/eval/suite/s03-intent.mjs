#!/usr/bin/env node
/**
 * s03 · 意图路由准确率（工单 24 指标 #3）
 *
 * ## 标签从哪来
 * `test/eval/intent-set.json` 50 条。当前 `label_status=ai-draft` —— AI 起草的标签，
 * **未经人工确认**。此时跑出来的数字是「模型 vs 另一套模型判断」的自一致性，
 * 不是准确率；报告里必须原样标明，否则就是拿假数字当结论。
 * 人工逐条核对后把 label_status 改成 human，这个数才有资格叫准确率。
 *
 * ## 为什么还要记录「行为一致性」
 * 标签对但行为错，仍然是失败：判成 knowledge 却一次检索都没调，
 * 说明门控（`toolsForIntent`）与路由结论脱节。所以除了 intent 比对，
 * 还要看「knowledge 类是否真的调了 retrieve_knowledge」。
 *
 * 输出：`s03-samples.json`（逐条原始事实，供 s04 复用，避免同一批请求打两遍）
 *
 * 用法：
 *   EVAL_PASSWORD=xxx node test/eval/suite/s03-intent.mjs
 *   S03_LIMIT=10 ...        # 只跑前 N 条（调试用）
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { login, sseStream, summarizeTurn } from '../lib/base.mjs';
import { createSuiteDir, writeItemJson, writeItemLog, EVAL_ROOT } from '../lib/report.mjs';
import { confusionMatrix } from '../lib/stats.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SET_PATH = join(EVAL_ROOT, 'intent-set.json');
const TARGET = 0.85;
const KNOWLEDGE_RECALL_TARGET = 0.9;

/** 需要检索才能答的意图（用于行为一致性判定） */
const NEEDS_RETRIEVE = new Set(['knowledge', 'knowledge_then_web']);

async function main() {
  const suiteDir = process.env.SUITE_DIR ?? createSuiteDir();
  const limit = Number(process.env.S03_LIMIT ?? 0);

  const set = JSON.parse(readFileSync(SET_PATH, 'utf8'));
  const defaultLabel = set.default_label_status ?? 'ai-draft';
  const items = (limit ? set.items.slice(0, limit) : set.items).map((x) => ({
    ...x,
    label_status: x.label_status ?? defaultLabel,
  }));

  console.log('s03 · 意图路由准确率');
  console.log('='.repeat(70));
  console.log(`标注集：${SET_PATH}（${items.length} 条，label_status=ai-draft）`);

  const draftAll = items.every((x) => x.label_status === 'ai-draft');
  if (draftAll) {
    console.log('  ⚠️ 全部标签是 AI 起草、未人工确认 —— 本次数字只能当自一致性基线');
  }

  const token = await login();
  const samples = [];
  const logLines = [];

  for (const [i, it] of items.entries()) {
    process.stdout.write(`  [${String(i + 1).padStart(2)}/${items.length}] ${it.q.slice(0, 22)} … `);
    let s = null;
    let err = null;
    try {
      const r = await sseStream(token, { content: it.q });
      s = summarizeTurn(r.events, r.wall_ms);
    } catch (e) {
      err = e instanceof Error ? e.message : String(e);
    }
    const predicted = s?.intent ?? null;
    const ok = predicted === it.intent;
    const tools = s?.tools ?? {};
    const retrieved = (tools.retrieve_knowledge ?? 0) > 0;
    const behaviorOk = NEEDS_RETRIEVE.has(it.intent) ? retrieved : !retrieved;

    samples.push({
      id: it.id,
      question: it.q,
      expected_intent: it.intent,
      predicted_intent: predicted,
      intent_ok: ok,
      expected_must_call: it.must_call,
      tools,
      tool_calls: s?.tool_calls ?? 0,
      retrieved,
      behavior_ok: behaviorOk,
      steps: s?.steps ?? 0,
      wall_ms: s?.wall_ms ?? 0,
      answer_len: s?.answer_len ?? 0,
      empty_answer: s?.empty_answer ?? null,
      error: err ?? (s?.errors?.length ? JSON.stringify(s.errors[0]).slice(0, 160) : null),
    });

    console.log(
      err
        ? `❌ ${err.slice(0, 40)}`
        : `${ok ? '✅' : '❌'} 判=${predicted} 应=${it.intent}　工具${s.tool_calls}次　${(s.wall_ms / 1000).toFixed(1)}s`,
    );
    if (!ok || !behaviorOk || err) {
      logLines.push(
        `- [${it.id}] ${it.q}\n  期望 ${it.intent} / 实际 ${predicted}；工具 ${JSON.stringify(tools)}；行为一致=${behaviorOk}${err ? `；错误 ${err}` : ''}`,
      );
    }
  }

  const total = samples.length;
  const correct = samples.filter((x) => x.intent_ok).length;
  const accuracy = total ? correct / total : 0;
  const behaviorOkCount = samples.filter((x) => x.behavior_ok).length;
  const behaviorRate = total ? behaviorOkCount / total : 0;

  // knowledge 类召回：标注为 knowledge / knowledge_then_web 的条目里判对的占比
  const kbRows = samples.filter((x) => NEEDS_RETRIEVE.has(x.expected_intent));
  const kbRecall = kbRows.length
    ? kbRows.filter((x) => NEEDS_RETRIEVE.has(x.predicted_intent)).length / kbRows.length
    : 1;

  // 未收到 data-plan（predicted=null）记为 unknown 单独成一列：路由完全没工作时必须看得见
  const cm = confusionMatrix(
    samples.map((x) => ({
      expected: x.expected_intent,
      actual: x.predicted_intent ?? 'unknown',
    })),
  );

  const passed = accuracy >= TARGET && kbRecall >= KNOWLEDGE_RECALL_TARGET;
  const status = passed ? 'pass' : 'fail';

  console.log('-'.repeat(70));
  console.log(
    `整体一致率 ${(accuracy * 100).toFixed(1)}%（${correct}/${total}，目标 ≥${TARGET * 100}%）`,
  );
  console.log(
    `knowledge 类召回 ${(kbRecall * 100).toFixed(1)}%（${kbRows.length} 条，目标 ≥${KNOWLEDGE_RECALL_TARGET * 100}%）`,
  );
  console.log(`行为一致率 ${(behaviorRate * 100).toFixed(1)}%（检索/不检索是否与意图匹配）`);
  console.log(
    '分意图：' +
      Object.entries(cm.perClass)
        .map(([k, v]) => `${k} ${v.recall === null ? '—' : Math.round(v.recall * v.support) + '/' + v.support}`)
        .join('　'),
  );

  const mistakes = samples.filter((x) => !x.intent_ok);

  const payload = {
    id: 's03',
    name: '意图路由准确率',
    status,
    metric: `${(accuracy * 100).toFixed(1)}%（${correct}/${total}）`,
    target: `整体 ≥${TARGET * 100}%，knowledge 类召回 ≥${KNOWLEDGE_RECALL_TARGET * 100}%`,
    conclusion: passed
      ? `整体一致率 ${(accuracy * 100).toFixed(1)}%，knowledge 类召回 ${(kbRecall * 100).toFixed(1)}%，行为一致率 ${(behaviorRate * 100).toFixed(1)}%`
      : `未达标：整体 ${(accuracy * 100).toFixed(1)}%、knowledge 召回 ${(kbRecall * 100).toFixed(1)}%；错判 ${mistakes.length} 条`,
    label_status: draftAll ? 'ai-draft' : 'mixed',
    label_note: draftAll
      ? '标注集由 AI 起草、未经人工确认：该数字是「模型 vs 模型判断」的自一致性，不能当准确率对外引用'
      : '部分标签已人工确认，详见 intent-set.json 各条的 label_status',
    accuracy,
    knowledge_recall: kbRecall,
    behavior_rate: behaviorRate,
    per_class: cm.perClass,
    confusion: { labels: cm.labels, matrix: cm.matrix },
    mistakes,
    samples_file: 's03-samples.json',
    caveats: [
      '五类意图是产品定义而非客观真值，只报与标注的一致率，不报「准确率 100%」',
      'plan 超时（5s）会降级为 knowledge —— 降级行的 intent 恒为 knowledge，会虚高 knowledge 类召回',
      '行为一致性用「是否真的调了 retrieve_knowledge」判定：needRetrieve 字段目前不下发到 SSE',
    ],
  };

  writeItemJson(suiteDir, 's03-intent', payload);
  writeItemJson(suiteDir, 's03-samples', { samples });
  writeItemLog(suiteDir, 's03-intent', logLines.join('\n\n') || '（无错判）');

  console.log('='.repeat(70));
  console.log(`结论：${payload.conclusion}`);
  console.log(`明细：${suiteDir}`);
  if (status !== 'pass') process.exitCode = 1;
}

main().catch((err) => {
  console.error('s03 执行失败:', err);
  process.exitCode = 1;
});
