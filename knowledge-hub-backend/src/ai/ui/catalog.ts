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

/** 联网搜索结果：对应 web_search 的返回 */
export const webLinksEntry = {
  summary:
    '联网搜索结果链接列表。results 每项含 title / url，最多 10 条。' +
    '用于展示「搜到了哪些网页」，不要用它复述网页内容。',
  props: z.object({
    /** 实际检索词（可能是改写后的），顶部展示便于核对 */
    query: z.string().max(200).default(''),
    results: z
      .array(
        z.object({
          title: z.string().default('（无标题）'),
          // url 允许为空：个别结果只有标题没有链接，因一条坏数据丢整块卡片不划算
          url: z.string().default(''),
        }),
      )
      .max(10),
  }),
  slots: false,
} as const;

/** 知识图谱迷你图：对应 retrieve_graph 的实体与关系 */
export const graphMiniEntry = {
  summary:
    '知识图谱实体关系图。entities 每项含 name / type / description，最多 20 个；' +
    'relations 每项含 source / relation / target，最多 40 条。用于展示「实体之间怎么连」。',
  props: z.object({
    entities: z
      .array(
        z.object({
          name: z.string().min(1),
          type: z.string().default(''),
          description: z.string().optional(),
        }),
      )
      .max(20),
    relations: z
      .array(
        z.object({
          source: z.string().min(1),
          relation: z.string().default(''),
          target: z.string().min(1),
        }),
      )
      .max(40),
  }),
  slots: false,
} as const;

/** 引用来源列表：对应 data-sources，[n] 与正文标注一一对应 */
export const sourceListEntry = {
  summary:
    '编号引用来源列表。sources 每项含 index（与正文 [n] 对应）/ kind(knowledge|web|graph) / title，' +
    '可选 ref / url / excerpt。用于「这个结论出自哪里」。',
  props: z.object({
    sources: z
      .array(
        z.object({
          index: z.number().int().min(1),
          kind: z.enum(['knowledge', 'web', 'graph']),
          title: z.string().default(''),
          ref: z.string().optional(),
          url: z.string().optional(),
          excerpt: z.string().optional(),
        }),
      )
      .max(50),
  }),
  slots: false,
} as const;

/** 记忆要点：对应 data-memory，展示「这次回答用到了哪些记忆」 */
export const memoryChipsEntry = {
  summary: '命中的记忆要点，最多 3 条，每条含 layer(user|session) 与 text。',
  props: z.object({
    memories: z
      .array(
        z.object({
          layer: z.enum(['user', 'session']),
          text: z.string().max(200),
        }),
      )
      .max(3),
  }),
  slots: false,
} as const;

/** 组件目录：key 即 SurfaceNode.type 的合法取值 */
export const CATALOG: Catalog = {
  stack: stackEntry,
  knowledgeCards: knowledgeCardsEntry,
  markdown: markdownEntry,
  webLinks: webLinksEntry,
  graphMini: graphMiniEntry,
  sourceList: sourceListEntry,
  memoryChips: memoryChipsEntry,
};

/** catalog 的 id 集合，供类型收窄与测试断言使用 */
export type CatalogId = keyof typeof CATALOG;
