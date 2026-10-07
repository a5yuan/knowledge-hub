import { Injectable, Logger } from '@nestjs/common';
import type { Chunk } from '../pipeline/chunker';
import type { Extraction } from './extraction.service';
import { Neo4jService } from './neo4j.service';

/** 写图入参：分块结果与逐块抽取结果（下标一一对应） */
export interface GraphInput {
  docId: string;
  title: string;
  chunks: Chunk[];
  extractions: Extraction[];
}

/** 聚合搜索命中：实体 */
export interface KgEntityHit {
  name: string;
  type: string;
  description: string | null;
}

/** 聚合搜索命中：RELATED_TO 边 */
export interface KgEdgeRow {
  sourceName: string;
  sourceType: string;
  relation: string;
  targetName: string;
  targetType: string;
}

/** 通用节点查询结果项（label + 节点业务属性，chunk 的 content 为 200 字预览） */
export interface KgNodeHit {
  label: 'entity' | 'document' | 'chunk';
  [key: string]: unknown;
}

/** 通用关系查询结果项（rel + 边两端摘要字段） */
export interface KgEdgeHit {
  rel: 'RELATED_TO' | 'MENTIONS' | 'HAS_CHUNK';
  [key: string]: unknown;
}

/** —— 全景图谱总览（GET /kg/overview，二期工单 07）—— */

/** 节点 id 约定（与 MERGE 键一致，全局唯一） */
export const kgNodeId = {
  document: (docId: string): string => `document:${docId}`,
  entity: (type: string, name: string): string => `entity:${type}:${name}`,
};

/** 画布节点（不含 Chunk 层：Chunk/HAS_CHUNK 属内部抽取结构） */
export interface KgOverviewNode {
  id: string;
  kind: 'document' | 'entity';
  /** document 节点 = title，entity 节点 = name */
  name: string;
  docId?: string;
  entityType?: string;
  description?: string | null;
}

/** 画布边：mentions 为 Document↔Entity 按 (docId, entity) 去重的直连边（原始 MENTIONS 挂在 Chunk 上） */
export interface KgOverviewEdge {
  source: string;
  target: string;
  kind: 'mentions' | 'related';
  relation?: string;
}

export interface KgOverviewStats {
  docNodes: number;
  entities: number;
  relatedEdges: number;
  mentionEdges: number;
  /** 标签体系预留，恒 0 */
  tags: number;
}

/** 热点实体 TOP5（按文档提及数降序） */
export interface KgHotEntity {
  name: string;
  entityType: string;
  mentionCount: number;
  relatedCount: number;
}

export interface KgOverview {
  nodes: KgOverviewNode[];
  edges: KgOverviewEdge[];
  stats: KgOverviewStats;
  typeDist: Array<{ type: string; count: number }>;
  hotTop5: KgHotEntity[];
  /** 节点数超 limit 被截断时为 true */
  truncated?: boolean;
}

/** 检索子图的文档直连边（Document→Entity 去重，供前端画文档节点与提及边） */
export interface KgDocEdgeRow {
  docId: string;
  title: string;
  entityName: string;
  entityType: string;
}

/**
 * 知识图谱构建服务（对应架构图"构建图谱""存储到 Neo4j"）
 * 图模型：(:Document)-[:HAS_CHUNK]->(:Chunk)-[:MENTIONS]->(:Entity)-[:RELATED_TO]->(:Entity)
 */
@Injectable()
export class KgService {
  private readonly logger = new Logger(KgService.name);

  constructor(private readonly neo4j: Neo4jService) { }

  /** 发布幂等入口（对齐 RAG"先删后写"）：先清旧图再构建 */
  async rebuildGraph(input: GraphInput): Promise<void> {
    await this.removeDocGraph(input.docId);
    await this.buildGraph(input);
  }

  /**
   * 构建图谱，按用户指定顺序三步写入：
   * ① Document 节点 + Chunk 节点 + HAS_CHUNK
   * ② Entity 节点（MERGE 按 name+type 去重）+ MENTIONS
   * ③ Entity 间 RELATED_TO
   */
  private async buildGraph({ docId, title, chunks, extractions }: GraphInput): Promise<void> {
    // ① 文档节点 → chunk 节点 → HAS_CHUNK
    await this.neo4j.run(
      `MERGE (d:Document {docId: $docId})
       SET d.title = $title
       WITH d
       UNWIND $chunks AS c
       MERGE (chk:Chunk {docId: $docId, chunkIndex: c.index})
       SET chk.content = c.content
       MERGE (d)-[:HAS_CHUNK]->(chk)`,
      {
        docId,
        title,
        chunks: chunks.map((c) => ({ index: c.index, content: c.content })),
      },
    );

    // ② 实体节点（去重合并）+ Chunk-[:MENTIONS]->Entity
    const mentions = extractions.flatMap((ext, i) =>
      ext.entities.map((e) => ({
        docId,
        chunkIndex: chunks[i].index,
        name: e.name,
        type: e.type,
        description: e.description ?? null,
      })),
    );
    if (mentions.length) {
      await this.neo4j.run(
        `UNWIND $mentions AS m
         MATCH (chk:Chunk {docId: m.docId, chunkIndex: m.chunkIndex})
         MERGE (e:Entity {name: m.name, type: m.type})
         SET e.description = coalesce(m.description, e.description)
         MERGE (chk)-[:MENTIONS]->(e)`,
        { mentions },
      );
    }

    // ③ 实体间 RELATED_TO（relation 存关系属性，动态关系词不建多关系类型）
    const rels = extractions.flatMap((ext) =>
      ext.relations.map((r) => ({
        sourceName: r.source.name,
        sourceType: r.source.type,
        targetName: r.target.name,
        targetType: r.target.type,
        relation: r.relation,
      })),
    );
    if (rels.length) {
      await this.neo4j.run(
        `UNWIND $rels AS r
         MATCH (a:Entity {name: r.sourceName, type: r.sourceType})
         MATCH (b:Entity {name: r.targetName, type: r.targetType})
         MERGE (a)-[rel:RELATED_TO]->(b)
         ON CREATE SET rel.relation = r.relation`,
        { rels },
      );
    }

    this.logger.log(
      `Neo4j 写图完成 docId=${docId} chunks=${chunks.length} entities=${mentions.length} relations=${rels.length}`,
    );
  }

  /**
   * 删除文档图谱（两步，用户指定顺序）：
   * ① 删 Document + 其 Chunk（DETACH DELETE 连带清理 HAS_CHUNK/MENTIONS）
   * ② 清理孤儿实体：不再被任何 Chunk MENTIONS 的 Entity（跨文档共享实体不受影响）
   */
  async removeDocGraph(docId: string): Promise<void> {
    await this.neo4j.run(
      `MATCH (d:Document {docId: $docId})
       OPTIONAL MATCH (d)-[:HAS_CHUNK]->(c:Chunk)
       DETACH DELETE d, c`,
      { docId },
    );
    await this.neo4j.run(
      `MATCH (e:Entity)
       WHERE NOT EXISTS { ()-[:MENTIONS]->(e) }
       DETACH DELETE e`,
    );
    this.logger.log(`Neo4j 图谱已清理 docId=${docId}`);
  }

  /** —— 以下为图谱只读查询（/kg 检索 API，Cypher 属性子串匹配）—— */

  /**
   * 实体 type 过滤 Cypher 片段（二期工单 07）：
   * person/org 精确匹配；knowledge 归并 tech/location/term/other；其余（含 document）不过滤
   * @param varName Cypher 变量名（如 'e' / 'a' / 'b'）
   */
  private typeCondition(varName: string, type: string | undefined): string {
    if (type === 'person' || type === 'org') return `${varName}.type = $type`;
    if (type === 'knowledge') return `${varName}.type IN ['tech','location','term','other']`;
    return '';
  }

  /**
   * ① 聚合搜索：q 同时匹配实体 name/description 与 RELATED_TO 的 relation/两端实体名
   * type 可选过滤实体与关系（document 类型时图侧返回空，仅 ES docs 生效）
   * docEdges：命中实体关联的文档直连边（Document→Entity 按 (docId, entity) 去重，前端画文档节点与提及边用）
   */
  async searchGraph(
    q: string,
    type: string | undefined,
    limit: number,
  ): Promise<{ entities: KgEntityHit[]; edges: KgEdgeRow[]; docEdges: KgDocEdgeRow[] }> {
    // type=document：图侧实体/关系为空，检索结果仅 ES 文档
    if (type === 'document') return { entities: [], edges: [], docEdges: [] };

    const lim = BigInt(limit);
    const params: Record<string, unknown> = { q, type: type ?? '', limit: lim };
    const entityCond = this.typeCondition('e', type);
    const entityWhere = `(${entityCond || 'true'})`;
    const aCond = this.typeCondition('a', type);
    const bCond = this.typeCondition('b', type);

    const entities = await this.neo4j.runRead(
      `MATCH (e:Entity)
       WHERE (toLower(e.name) CONTAINS toLower($q) OR toLower(coalesce(e.description, '')) CONTAINS toLower($q))
         AND ${entityWhere}
       RETURN e.name AS name, e.type AS type, e.description AS description
       ORDER BY e.name LIMIT $limit`,
      params,
    );
    const edges = await this.neo4j.runRead(
      `MATCH (a:Entity)-[r:RELATED_TO]->(b:Entity)
       WHERE ((toLower(r.relation) CONTAINS toLower($q))
          OR (toLower(a.name) CONTAINS toLower($q))
          OR (toLower(b.name) CONTAINS toLower($q)))
         AND (${aCond || 'true'}) AND (${bCond || 'true'})
       RETURN a.name AS sourceName, a.type AS sourceType, r.relation AS relation,
              b.name AS targetName, b.type AS targetType
       ORDER BY relation, sourceName LIMIT $limit`,
      params,
    );
    const docEdges = await this.neo4j.runRead(
      `MATCH (d:Document)-[:HAS_CHUNK]->(:Chunk)-[:MENTIONS]->(e:Entity)
       WHERE (toLower(e.name) CONTAINS toLower($q) OR toLower(coalesce(e.description, '')) CONTAINS toLower($q))
         AND ${entityWhere}
       RETURN DISTINCT d.docId AS docId, d.title AS title, e.name AS entityName, e.type AS entityType
       ORDER BY docId, entityName LIMIT $limit`,
      params,
    );
    return {
      entities: entities as unknown as KgEntityHit[],
      edges: edges as unknown as KgEdgeRow[],
      docEdges: docEdges as unknown as KgDocEdgeRow[],
    };
  }

  /**
   * ⓪ 全景图谱总览（二期工单 07）：全量节点/边 + 统计 + 类型分布 + 热点 TOP5
   * 不含 Chunk/HAS_CHUNK 层；mentions 边为 Document↔Entity 按 (docId, entity) 去重的直连边
   */
  async getOverview(limit: number): Promise<KgOverview> {
    const docRows = await this.neo4j.runRead(
      `MATCH (d:Document)
       RETURN d.docId AS docId, d.title AS title
       ORDER BY d.docId`,
    );
    // mentionCount = 覆盖文档数（DISTINCT Document，经 Chunk 中转）；relatedCount = 相邻实体数
    const entityRows = await this.neo4j.runRead(
      `MATCH (e:Entity)
       OPTIONAL MATCH (d:Document)-[:HAS_CHUNK]->(:Chunk)-[:MENTIONS]->(e)
       WITH e, count(DISTINCT d) AS mentionCount
       OPTIONAL MATCH (e)-[:RELATED_TO]-(o:Entity)
       RETURN e.name AS name, e.type AS type, e.description AS description,
              mentionCount, count(DISTINCT o) AS relatedCount`,
    );
    const relatedRows = await this.neo4j.runRead(
      `MATCH (a:Entity)-[r:RELATED_TO]->(b:Entity)
       RETURN a.name AS sourceName, a.type AS sourceType, r.relation AS relation,
              b.name AS targetName, b.type AS targetType`,
    );
    const mentionRows = await this.neo4j.runRead(
      `MATCH (d:Document)-[:HAS_CHUNK]->(:Chunk)-[:MENTIONS]->(e:Entity)
       RETURN DISTINCT d.docId AS docId, e.name AS entityName, e.type AS entityType`,
    );
    const distRows = await this.neo4j.runRead(
      `MATCH (e:Entity)
       RETURN e.type AS type, count(*) AS count
       ORDER BY count DESC, type`,
    );

    const docNodes: KgOverviewNode[] = docRows.map((r) => ({
      id: kgNodeId.document(r.docId as string),
      kind: 'document',
      name: (r.title as string) ?? (r.docId as string),
      docId: r.docId as string,
    }));
    const entityRowsWithCount = entityRows.map((r) => ({
      node: {
        id: kgNodeId.entity(r.type as string, r.name as string),
        kind: 'entity' as const,
        name: r.name as string,
        entityType: r.type as string,
        description: (r.description as string | null) ?? null,
      },
      mentionCount: Number(r.mentionCount ?? 0),
      relatedCount: Number(r.relatedCount ?? 0),
    }));
    const allEdges: KgOverviewEdge[] = [
      ...relatedRows.map((r) => ({
        source: kgNodeId.entity(r.sourceType as string, r.sourceName as string),
        target: kgNodeId.entity(r.targetType as string, r.targetName as string),
        kind: 'related' as const,
        relation: (r.relation as string) ?? '',
      })),
      ...mentionRows.map((r) => ({
        source: kgNodeId.document(r.docId as string),
        target: kgNodeId.entity(r.entityType as string, r.entityName as string),
        kind: 'mentions' as const,
      })),
    ];

    // 超限截断：文档节点全保留，实体按提及数降序保留，边仅保留两端均在画布内的
    let truncated = false;
    let kept = entityRowsWithCount;
    if (docNodes.length + kept.length > limit) {
      truncated = true;
      kept = [...kept]
        .sort((a, b) => b.mentionCount - a.mentionCount || b.relatedCount - a.relatedCount)
        .slice(0, Math.max(0, limit - docNodes.length));
    }
    const keepIds = new Set<string>(docNodes.map((n) => n.id));
    for (const k of kept) keepIds.add(k.node.id);
    const edges = allEdges.filter((e) => keepIds.has(e.source) && keepIds.has(e.target));
    const nodes: KgOverviewNode[] = [...docNodes, ...kept.map((k) => k.node)];

    const hotTop5: KgHotEntity[] = [...kept]
      .sort((a, b) => b.mentionCount - a.mentionCount || b.relatedCount - a.relatedCount)
      .slice(0, 5)
      .map((k) => ({
        name: k.node.name,
        entityType: k.node.entityType ?? 'other',
        mentionCount: k.mentionCount,
        relatedCount: k.relatedCount,
      }));

    return {
      nodes,
      edges,
      stats: {
        docNodes: docNodes.length,
        entities: kept.length,
        relatedEdges: allEdges.filter((e) => e.kind === 'related').length,
        mentionEdges: allEdges.filter((e) => e.kind === 'mentions').length,
        tags: 0,
      },
      typeDist: distRows.map((r) => ({ type: r.type as string, count: Number(r.count ?? 0) })),
      hotTop5,
      ...(truncated ? { truncated: true } : {}),
    };
  }

  /** ② 通用节点查询：label 分派 Cypher，q 匹配对应节点属性（空 q=全量），entity 可选 type 过滤，分页 */
  async searchNodes(
    label: 'entity' | 'document' | 'chunk',
    q: string,
    type: string | undefined,
    page: number,
    pageSize: number,
  ): Promise<{ total: number; items: KgNodeHit[] }> {
    const skip = (page - 1) * pageSize;
    const params: Record<string, unknown> = { q, type: type ?? '', skip: BigInt(skip), limit: BigInt(pageSize) };
    const hasQ = q.length > 0;

    // 各 label 的 MATCH 变量与 WHERE（仅 entity 支持 type 过滤；条件用括号包裹，防 AND/OR 优先级问题）
    let match: string;
    let where = '';
    if (label === 'entity') {
      match = 'MATCH (e:Entity)';
      const conds: string[] = [];
      if (hasQ) {
        conds.push("(toLower(e.name) CONTAINS toLower($q) OR toLower(coalesce(e.description, '')) CONTAINS toLower($q))");
      }
      if (type) conds.push('e.type = $type');
      where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
    } else if (label === 'document') {
      match = 'MATCH (d:Document)';
      where = hasQ ? 'WHERE toLower(d.title) CONTAINS toLower($q)' : '';
    } else {
      match = 'MATCH (c:Chunk)';
      where = hasQ ? 'WHERE toLower(c.content) CONTAINS toLower($q)' : '';
    }

    // total 与 items 共用 MATCH/WHERE
    const countRows = await this.neo4j.runRead(`${match} ${where} RETURN count(*) AS total`, params);
    const total = Number(countRows[0]?.total ?? 0);

    const returnCypher =
      label === 'entity'
        ? `OPTIONAL MATCH (chk:Chunk)-[:MENTIONS]->(e)
           OPTIONAL MATCH (e)-[:RELATED_TO]-(o:Entity)
           RETURN e.name AS name, e.type AS type, e.description AS description,
                  count(DISTINCT chk) AS mentionCount, count(DISTINCT o) AS relatedCount
           ORDER BY mentionCount DESC, name SKIP $skip LIMIT $limit`
        : label === 'document'
          ? `RETURN d.docId AS docId, d.title AS title
             ORDER BY d.docId SKIP $skip LIMIT $limit`
          : `RETURN c.docId AS docId, c.chunkIndex AS chunkIndex, left(c.content, 200) AS contentPreview
             ORDER BY c.docId, c.chunkIndex SKIP $skip LIMIT $limit`;
    const rows = await this.neo4j.runRead(`${match} ${where} ${returnCypher}`, params);
    const items: KgNodeHit[] = rows.map((r) => ({ label, ...r }));
    return { total, items };
  }

  /** ③ 通用关系查询：rel 分派 Cypher，entity 可选过滤边两端的 Entity 节点（has_chunk 无 Entity 端，忽略），分页 */
  async searchEdges(
    rel: 'related_to' | 'mentions' | 'has_chunk',
    entity: string | undefined,
    page: number,
    pageSize: number,
  ): Promise<{ total: number; items: KgEdgeHit[] }> {
    const skip = (page - 1) * pageSize;
    const params: Record<string, unknown> = { entity: entity ?? '', skip: BigInt(skip), limit: BigInt(pageSize) };

    const cyphers: Record<typeof rel, { match: string; where: string; ret: string }> = {
      related_to: {
        match: 'MATCH (a:Entity)-[r:RELATED_TO]->(b:Entity)',
        where: entity ? 'WHERE a.name = $entity OR b.name = $entity' : '',
        ret: `RETURN a.name AS sourceName, a.type AS sourceType, r.relation AS relation,
                     b.name AS targetName, b.type AS targetType
              ORDER BY relation, sourceName SKIP $skip LIMIT $limit`,
      },
      mentions: {
        match: 'MATCH (c:Chunk)-[:MENTIONS]->(e:Entity)',
        where: entity ? 'WHERE e.name = $entity' : '',
        ret: `RETURN c.docId AS chunkDocId, c.chunkIndex AS chunkIndex,
                     e.name AS entityName, e.type AS entityType
              ORDER BY chunkDocId, chunkIndex SKIP $skip LIMIT $limit`,
      },
      has_chunk: {
        match: 'MATCH (d:Document)-[:HAS_CHUNK]->(c:Chunk)',
        where: '',
        ret: `RETURN d.docId AS docId, d.title AS title, c.chunkIndex AS chunkIndex,
                     left(c.content, 200) AS contentPreview
              ORDER BY d.docId, c.chunkIndex SKIP $skip LIMIT $limit`,
      },
    };
    const { match, where, ret } = cyphers[rel];

    const countRows = await this.neo4j.runRead(`${match} ${where} RETURN count(*) AS total`, params);
    const total = Number(countRows[0]?.total ?? 0);
    const rows = await this.neo4j.runRead(`${match} ${where} ${ret}`, params);
    const relLabel = rel === 'related_to' ? 'RELATED_TO' : rel === 'mentions' ? 'MENTIONS' : 'HAS_CHUNK';
    const items: KgEdgeHit[] = rows.map((r) => ({ rel: relLabel, ...r }));
    return { total, items };
  }
}
