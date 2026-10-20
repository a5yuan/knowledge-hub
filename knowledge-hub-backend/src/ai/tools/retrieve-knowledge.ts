/**
 * retrieve_knowledge（工单 11 阶段2+3，工单 23 抽取）。
 *
 * 混合检索（仅可见文档）+ 自动切题评估，返回评估结论与切题资料（全局 [n] 编号，
 * 与 `data-sources` 序号一致）；09 号工单的 scope 过滤保留。
 *
 * 逐行搬运，改动仅三处：
 * 1. `this.ragSearch` → `deps.rag`、`this.gradeChunks` → `deps.grader`、`this.logger` → `deps.logger`
 * 2. `this.registerSource(...)` → `deps.sources.register(...)`
 * 3. `this.emit(res, 'data-status', ...)` → `deps.events.status(...)`
 *
 * 另把 `overallGrade` / `gradeLabel` 两个纯函数从 service 迁到本文件作用域 ——
 * 它们只被本工具使用（grep 确认无其它调用点）。
 */
import type { VisibilityScope } from '../../es/visibility-scope';
import type {
  ChunkGrade,
  KnowledgeItem,
  OverallGrade,
  ToolDeps,
  ToolResult,
} from './types';
import { KNOWLEDGE_CONTENT_SLICE } from './constants';

/** 调用上下文：question 用于切题评估，scope 用于可见性过滤 */
export interface RetrieveKnowledgeCtx {
  question: string;
  scope?: VisibilityScope;
}

export async function retrieveKnowledge(
  input: { query: string },
  ctx: RetrieveKnowledgeCtx,
  deps: ToolDeps,
): Promise<ToolResult> {
  try {
    const { items } = await deps.rag.search(input.query, 5, true, ctx.scope);
    if (items.length === 0) {
      return {
        summary: '知识库 0 条命中',
        content: '评估结论：无结果。知识库中未检索到相关内容。',
        grade: 'none',
        items: [] as KnowledgeItem[],
      };
    }
    deps.events.status('grade', '评估资料...');
    const grades = await deps.grader(
      ctx.question,
      items.map((it) => ({ title: it.doc_title, content: it.content })),
    );
    const kept = items.filter(
      (_, i) => grades === null || grades[i] !== 'off_topic',
    );
    const overall = overallGrade(grades, items.length);
    const dropped = items.length - kept.length;
    deps.events.status(
      'grade',
      `切题评估：${gradeLabel(overall)}${dropped > 0 ? ` · 剔除不切题 ${dropped} 条` : ''}`,
    );
    if (kept.length === 0) {
      return {
        summary: `知识库 ${items.length} 条均不切题`,
        content: `评估结论：不切题。检索到的 ${items.length} 条资料与问题无关，不能作为依据。请用 rewrite_query 换检索词重试，或基于已有信息回答并向用户说明知识库无相关内容。`,
        grade: 'off_topic',
        items: [] as KnowledgeItem[],
      };
    }
    const outItems: KnowledgeItem[] = [];
    const lines: string[] = [];
    for (const it of kept) {
      const n = deps.sources.register({
        kind: 'knowledge',
        title: it.doc_title,
        ref: it.doc_id,
        excerpt: it.content.slice(0, deps.config.excerptLen),
        heading: null,
      });
      outItems.push({
        documentId: it.doc_id,
        documentTitle: it.doc_title,
        excerpt: it.content.slice(0, deps.config.excerptLen),
        content: it.content,
      });
      lines.push(
        `[${n}] ${it.doc_title}\n${it.content.slice(0, KNOWLEDGE_CONTENT_SLICE)}`,
      );
    }
    const label = gradeLabel(overall);
    return {
      summary: `知识库命中 ${items.length} 条 · ${label}`,
      content: `评估结论：${label}（可用 ${kept.length}/${items.length} 条）\n\n${lines.join('\n\n')}`,
      grade: overall,
      items: outItems,
    };
  } catch (err) {
    deps.logger.warn(
      `retrieve_knowledge 降级: ${err instanceof Error ? err.message : err}`,
    );
    return {
      summary: '知识库检索暂不可用',
      content:
        '知识库检索服务暂时不可用，请基于已有信息回答，并提示用户稍后重试检索。',
      grade: 'none',
      items: [] as KnowledgeItem[],
    };
  }
}

/**
 * 汇总整体评估态：无资料→none；评估降级→on_topic；全不切题→off_topic；
 * 有切题→on_topic；否则 partial。
 */
export function overallGrade(
  grades: ChunkGrade[] | null,
  count: number,
): OverallGrade {
  if (count === 0) return 'none';
  if (grades === null) return 'on_topic';
  if (grades.every((g) => g === 'off_topic')) return 'off_topic';
  if (grades.some((g) => g === 'on_topic')) return 'on_topic';
  return 'partial';
}

/** 评估态中文文案（对齐原图四态） */
export function gradeLabel(grade: OverallGrade): string {
  switch (grade) {
    case 'on_topic':
      return '切题';
    case 'partial':
      return '部分相关';
    case 'off_topic':
      return '不切题';
    default:
      return '无结果';
  }
}
