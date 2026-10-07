import { request } from './http'
import { endpoint } from './endpoint'

/** 全景图谱节点（后端 KgOverviewNode，id 约定 document:{docId} / entity:{type}:{name}） */
export interface GraphNode {
  id: string
  kind: 'document' | 'entity'
  /** document 节点 = title，entity 节点 = name */
  name: string
  docId?: string
  entityType?: 'person' | 'org' | 'tech' | 'location' | 'term' | 'other'
  description?: string | null
}

/** 全景图谱边：mentions=文档直连提及（Document↔Entity 去重），related=实体关联 */
export interface GraphEdge {
  source: string
  target: string
  kind: 'mentions' | 'related'
  relation?: string
}

export interface GraphStats {
  docNodes: number
  entities: number
  relatedEdges: number
  mentionEdges: number
  /** 标签体系预留，恒 0 */
  tags: number
}

export interface TypeDistItem {
  type: string
  count: number
}

export interface HotEntity {
  name: string
  entityType: string
  mentionCount: number
  relatedCount: number
}

/** GET /kg/overview 响应：全量图谱 + 统计 + 类型分布 + 热点 TOP5 */
export interface GraphOverview {
  nodes: GraphNode[]
  edges: GraphEdge[]
  stats: GraphStats
  typeDist: TypeDistItem[]
  hotTop5: HotEntity[]
  truncated?: boolean
}

/** 检索命中实体（GET /kg/search entities 项） */
export interface GraphEntityHit {
  name: string
  type: string
  description: string | null
}

/** 检索命中关联边（GET /kg/search edges 项，实体 name/type 形式） */
export interface GraphEdgeRow {
  sourceName: string
  sourceType: string
  relation: string
  targetName: string
  targetType: string
}

/** 检索命中文档直连边（Document→Entity 去重，前端画文档节点与提及边用） */
export interface GraphDocEdgeRow {
  docId: string
  title: string
  entityName: string
  entityType: string
}

/** GET /kg/search 响应（现有结构 + docEdges 追加） */
export interface GraphSearchResult {
  q: string
  docs: { total: number; page: number; pageSize: number; items: Array<{ doc_id?: string; title?: string }> }
  entities: GraphEntityHit[]
  edges: GraphEdgeRow[]
  docEdges: GraphDocEdgeRow[]
}

export type GraphSearchType = 'person' | 'org' | 'knowledge' | 'document'

/** 全景图谱总览（进入页面拉全图与统计） */
export function fetchGraphOverview(limit?: number): Promise<GraphOverview> {
  const { baseURL, url } = endpoint('graphs', '/overview')
  return request<GraphOverview>({ baseURL, url, method: 'get', params: limit ? { limit } : undefined })
}

/** 聚合检索（关键词 + 可选实体类型过滤），用于画布切换为命中子图 */
export function searchGraph(params: { q: string; type?: GraphSearchType; page?: number; pageSize?: number }): Promise<GraphSearchResult> {
  const { baseURL, url } = endpoint('graphs', '/search')
  return request<GraphSearchResult>({ baseURL, url, method: 'get', params })
}
