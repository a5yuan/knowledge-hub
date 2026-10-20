/**
 * rewrite_query（工单 11 阶段4，工单 23 抽取）。
 *
 * 依据不足原因与新检索词换一种问法再查；是否改写、用什么词由模型自主决定，
 * 全轮最多 1 次（预算在编排循环中强制，本文件不管）。
 *
 * ⚠️ 原实现返回 `{ ..., query: q }`，编排循环**从不读取**该字段（只消费 `content`）。
 * 抽取时改名为 `rewrite` 以避免与工具入参 `query` 混淆 —— 无可观察行为变化。
 */
import type { ToolDeps, ToolResult } from './types';

/** 改写入参（对应 schema：reason + terms） */
export interface RewriteQueryInput {
  reason: string;
  terms: string[];
}

export function rewriteQuery(
  input: RewriteQueryInput,
  deps: ToolDeps,
): ToolResult {
  const q = (input.terms ?? [])
    .map((t) => String(t).trim())
    .filter(Boolean)
    .join(' ');
  if (!q) {
    return {
      summary: '改写无效',
      content:
        '改写无效：未提供检索词。请基于原检索词继续，或直接基于已有信息回答。',
    };
  }
  deps.events.status('rewrite', `改写查询：${q}`);
  return {
    summary: `已改写：${q}`,
    content: `已将检索词改写为：${q}（不足原因：${input.reason || '信息不足'}）。请立刻用该检索词调用 retrieve_knowledge 重新检索。`,
    rewrite: q,
  };
}
