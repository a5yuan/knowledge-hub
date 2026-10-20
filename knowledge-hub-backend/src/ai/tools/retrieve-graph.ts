/**
 * retrieve_graph（工单 12，工单 23 抽取）。
 *
 * 调 `kg.searchGraph` 查实体关系子图；每条 RELATED_TO 三元组登记一条 `kind='graph'` 来源
 * （参与全局 [n] 编号），并返回 entities / relations 供编排循环 emit `data-graph`。
 * 不过 Grader（子串精确命中噪音低，topK 截断直进）；Neo4j 不可用/查询失败降级为提示文本，流不中断。
 *
 * 逐行搬运，唯一改动是依赖从 `this.*` 改为 `deps.*`，以及截断常量从模块作用域改为 `constants.ts`。
 */
import type { GraphEntity, GraphRelation, ToolDeps, ToolResult } from './types';
import { GRAPH_ENTITY_LIMIT, GRAPH_RELATION_LIMIT } from './constants';

export async function retrieveGraph(
  input: { query: string },
  deps: ToolDeps,
): Promise<ToolResult> {
  try {
    const { entities, edges } = await deps.kg.searchGraph(
      input.query,
      undefined,
      GRAPH_ENTITY_LIMIT,
    );
    const ents = entities.slice(0, GRAPH_ENTITY_LIMIT).map((e) => ({
      name: e.name,
      type: e.type,
      description: e.description ?? undefined,
    }));
    const relations = edges.slice(0, GRAPH_RELATION_LIMIT).map((e) => ({
      source: e.sourceName,
      relation: e.relation,
      target: e.targetName,
    }));
    // 补齐关系两端但未命中实体列表的实体（保证前端 mini 力导图节点着色完整）
    for (const e of edges.slice(0, GRAPH_RELATION_LIMIT)) {
      if (!ents.some((x) => x.name === e.sourceName)) {
        ents.push({
          name: e.sourceName,
          type: e.sourceType,
          description: undefined,
        });
      }
      if (!ents.some((x) => x.name === e.targetName)) {
        ents.push({
          name: e.targetName,
          type: e.targetType,
          description: undefined,
        });
      }
    }
    if (relations.length === 0) {
      return {
        summary: `图谱 0 条命中（实体 ${ents.length}）`,
        content:
          '知识图谱中未检索到与该主题相关的实体关系，请改用 retrieve_knowledge 检索文档资料。',
        entities: ents,
        relations: [] as GraphRelation[],
      };
    }
    // 每条关系三元组登记一条 graph 来源（ref 去重），与文档 chunk 粒度对齐
    const lines: string[] = [];
    for (const r of relations) {
      const src = ents.find((e) => e.name === r.source);
      const tgt = ents.find((e) => e.name === r.target);
      const n = deps.sources.register({
        kind: 'graph',
        title: `${r.source} —${r.relation}→ ${r.target}`,
        ref: `graph:${r.source}->${r.relation}->${r.target}`,
        excerpt:
          (src?.description ?? tgt?.description ?? '').slice(
            0,
            deps.config.excerptLen,
          ) || undefined,
        heading: null,
      });
      lines.push(
        `[${n}] 图谱关系：${r.source}（${src?.type ?? 'unknown'}）—${r.relation}→ ${r.target}（${tgt?.type ?? 'unknown'}）`,
      );
    }
    const entText = ents
      .map(
        (e) =>
          `${e.name}（${e.type}${e.description ? `：${e.description}` : ''}）`,
      )
      .join('；');
    return {
      summary: `图谱命中 实体 ${ents.length} / 关系 ${relations.length}`,
      content: `知识图谱实体关系（描述实体间审批/归属/关联等事实，可作回答依据并标 [n]）：\n\n${lines.join('\n')}\n\n相关实体：${entText}`,
      entities: ents,
      relations,
    };
  } catch (err) {
    deps.logger.warn(
      `retrieve_graph 降级: ${err instanceof Error ? err.message : err}`,
    );
    return {
      summary: '知识图谱暂不可用',
      content:
        '知识图谱服务暂时不可用，请仅依据文档资料回答，不要编造实体关系。',
      entities: [] as GraphEntity[],
      relations: [] as GraphRelation[],
      degraded: true,
    };
  }
}
