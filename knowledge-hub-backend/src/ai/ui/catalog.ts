/**
 * 组件目录（catalog）：Agent 能用的界面组件白名单。
 *
 * 这是整个生成式 UI 的**权限模型**——不在本文件里的组件，模型画不出来。
 * `summary` 不是注释，是给模型看的：注入 prompt 时只取 `id + summary + 必填 props 名`，
 * 不注入完整 zod schema（7 个组件的完整描述约 300 行，常驻注入等于每轮对话都付一遍 token）。
 *
 * 新增一种展示形态的正确姿势：在这里加一条 + 前端 registry.ts 加一行映射。
 * 不需要动任何事件类型或渲染分支——这就是抽这层的目的。
 */
import { z } from 'zod';
import type { Catalog } from './surface';

/** 纵向布局容器：Agent 用它决定「先卡片后来源」这类编排顺序 */
export const stackEntry = {
  summary: '纵向排列子节点，gap 为间距（px，0-32）',
  props: z.object({
    gap: z.number().int().min(0).max(32).default(8),
  }),
  slots: true,
} as const;

/** 知识库文档卡片列表：对应 retrieve_knowledge 的检索结果 */
export const knowledgeCardsEntry = {
  summary:
    '知识库文档卡片列表。items 每项含 documentId / documentTitle / excerpt，最多 10 条。' +
    '用于展示「检索到哪些文档」，不要用它输出正文。',
  props: z.object({
    /** 检索词，卡片区顶部展示，便于用户核对检索意图 */
    query: z.string().max(200).default(''),
    items: z
      .array(
        z.object({
          documentId: z.string().min(1),
          // 标题不设 min(1)：后端文档标题理论上可能为空，若因此丢掉整块卡片损失过大，
          // 展示侧用 UNTITLED_LABEL 兜底更合适
          documentTitle: z.string(),
          // excerpt 允许为空：0 命中时 items 为空数组，正常命中时 excerpt 一定存在
          excerpt: z.string().default(''),
        }),
      )
      .max(10),
  }),
  slots: false,
} as const;

/** markdown 兜底：任何 surface 校验失败都可退化到它，保证不白屏 */
export const markdownEntry = {
  summary: 'markdown 正文，仅用于纯文本兜底，不要用于结构化结果',
  props: z.object({
    content: z.string().max(20000),
  }),
  slots: false,
} as const;

/** 组件目录：key 即 SurfaceNode.type 的合法取值 */
export const CATALOG: Catalog = {
  stack: stackEntry,
  knowledgeCards: knowledgeCardsEntry,
  markdown: markdownEntry,
};

/** catalog 的 id 集合，供类型收窄与测试断言使用 */
export type CatalogId = keyof typeof CATALOG;
