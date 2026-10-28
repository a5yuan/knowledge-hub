/**
 * 知识库检索结果 → surface 的纯函数 builder。
 *
 * 为什么是纯函数：
 * - 可单测（输入固定则输出固定，直接快照比对）
 * - 回放可用（刷新页面后按 sources 重建，不必把 surface 落库）
 *
 * 为什么放在编排层而不是工具层：工具只返回 `ToolResult`（见 tools/types.ts 的设计边界），
 * 「怎么展示」是编排层的事，工具不该知道自己被渲染成卡片还是表格。
 */
import type { KnowledgeItem } from '../../tools/types';
import type { Surface } from '../surface';

/** 单调递增序号：surfaceId 只做前端渲染 key，不落库，故不用雪花 ID */
let seq = 0;

export function nextSurfaceId(): string {
  seq = (seq + 1) % 100000;
  return `s_${Date.now().toString(36)}_${seq}`;
}

/** 卡片标题为空时的兜底文案（后端宽容放行，展示侧补位） */
export const UNTITLED_LABEL = '（无标题文档）';

/**
 * 构建「检索结果」界面：一张竖向栈，里面放文档卡片列表。
 *
 * 节点 id 用带语义的名字（root / cards）而非随机串——调试时能一眼看出结构，
 * 且同一个 builder 每次产出的结构完全一致，快照测试才有意义。
 *
 * 注意：props 直接内联真实数据，不使用 `@data.xxx` 指针。
 * 指针需要在校验前解析才能通过 zod，而 MVP 只有一个组件消费数据、没有共享收益，
 * 所以先不做（P1 要支持多组件共享时，在 validateSurface 入口统一解析）。
 */
export function buildKnowledgeSurface(input: {
  query: string;
  items: KnowledgeItem[];
  /** 复用外部已生成的 id（如需要与某次请求关联）；不传则内部生成 */
  surfaceId?: string;
}): Surface {
  // excerpt 可能超长：卡片只展示摘要，限制长度避免 surface 体积膨胀
  const items = input.items.slice(0, 10).map((it) => ({
    documentId: it.documentId,
    documentTitle: it.documentTitle,
    excerpt:
      it.excerpt.length > 160 ? `${it.excerpt.slice(0, 160)}…` : it.excerpt,
  }));

  return {
    surfaceId: input.surfaceId ?? nextSurfaceId(),
    root: 'root',
    nodes: {
      root: {
        type: 'stack',
        props: { gap: 8 },
        children: ['cards'],
      },
      cards: {
        type: 'knowledgeCards',
        props: { query: input.query, items },
      },
    },
  };
}
