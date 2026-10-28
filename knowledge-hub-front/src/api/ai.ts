import { endpoint, rawCall } from './endpoint'
import { request } from './http'

/** AI 会话（kh_ai_session 视图） */
export interface AiSessionView {
  id: string
  title: string
  /** 最新 assistant 回答前 30 字（列表副标题），无则空串 */
  preview?: string
  updatedAt: string
}

/** 引用来源 v2（工单 08 v2 协议）：index/kind/title/ref/url/excerpt；12 号工单 kind 新增 graph */
export interface AiSource {
  index: number
  kind: 'knowledge' | 'web' | 'graph'
  title: string
  ref?: string
  url?: string
  excerpt?: string
  heading?: string | null
}

/** AI 消息（kh_ai_message 视图） */
export interface AiMessageView {
  id: string
  role: 'user' | 'assistant'
  content: string
  sources: AiSource[] | null
  /**
   * 生成式 UI 蓝图（genui 方案 A：随消息落库）。
   * 回放时直接用它还原卡片；为 null 表示该消息没有结构化结果或当时校验失败。
   */
  surface: Surface | null
  createdAt: string
}

/** —— surface：Agent 输出的界面蓝图（生成式 UI，见 docs/engineering/genui-surface.md） —— */

/**
 * 单个界面节点。
 * 扁平存储：`children` 只存 id，真正的节点在 `Surface.nodes` 里查。
 * 这样校验一次遍历就够，将来做增量更新也能按 id 直接命中。
 */
export interface SurfaceNode {
  /** catalog 中的组件 id；前端 registry.ts 是唯一白名单 */
  type: string
  props?: Record<string, unknown>
  /** 子节点 id 列表，顺序即渲染顺序 */
  children?: string[]
}

/** 一次界面输出的完整描述 */
export interface Surface {
  /** 仅作渲染 key，无业务语义 */
  surfaceId: string
  root: string
  nodes: Record<string, SurfaceNode>
  /** 共享数据（MVP 未启用，P1 供多个组件引用同一批数据时用） */
  data?: Record<string, unknown>
}

/** —— v2 事件载荷（单通道 data: {"type","data"}，所有字段统一嵌套在 data 内） —— */
export interface AiEventData {
  type: string
  data?: {
    // start / finish
    messageId?: string
    // data-session
    sessionId?: string
    // start-step
    step?: number
    // data-status
    stage?: string
    text?: string
    // data-plan（工单 11：意图分类 + 建议检索词）
    intent?: string
    suggestedTerms?: string[]
    // data-retrieve
    query?: string
    items?: Array<{ documentId: string; documentTitle: string; excerpt: string }>
    // data-web-search
    results?: Array<{ title: string; url: string }>
    // data-graph（12 号工单：知识图谱实体关系子图；source/target 为实体名，可直接作 ECharts 节点 id）
    entities?: Array<{ name: string; type: string; description?: string }>
    relations?: Array<{ source: string; relation: string; target: string }>
    // data-memory（工单 10：Mem0 命中记忆）
    memories?: Array<{ layer: 'user' | 'session'; text: string }>
    // reasoning-* / text-*
    id?: string
    delta?: string
    // data-sources（工单 11：仅被 [n] 引用的来源；后端无标记时回退全量）
    sources?: AiSource[]
    // data-surface（生成式 UI：界面蓝图；校验失败时后端不下发，前端回退旧分支）
    surface?: Surface
    // finish
    suggestions?: string[]
    // error
    message?: string
  }
}

/** v2 事件分发回调（按 data.type 分发） */
export interface AiStreamHandlers {
  onStart?: (data: { messageId: string }) => void
  onSession?: (data: { sessionId: string }) => void
  onStartStep?: (data: { step: number }) => void
  onStatus?: (data: { stage: string; text: string }) => void
  /** 工单 11：意图路由结果（五类意图 + 建议检索词） */
  onPlan?: (data: { intent: string; suggestedTerms: string[] }) => void
  onRetrieve?: (data: { query: string; items: Array<{ documentId: string; documentTitle: string; excerpt: string }> }) => void
  onWebSearch?: (data: { query: string; results: Array<{ title: string; url: string }> }) => void
  /** 12 号工单：知识图谱实体关系子图（retrieve_graph 工具） */
  onGraph?: (data: {
    query: string
    entities: Array<{ name: string; type: string; description?: string }>
    relations: Array<{ source: string; relation: string; target: string }>
  }) => void
  onMemory?: (data: { memories: Array<{ layer: 'user' | 'session'; text: string }> }) => void
  onReasoningStart?: (data: { id: string }) => void
  onReasoningDelta?: (data: { id: string; delta: string }) => void
  onReasoningEnd?: (data: { id: string }) => void
  onTextDelta?: (data: { id: string; delta: string }) => void
  onSources?: (data: { sources: AiSource[] }) => void
  /** 生成式 UI：界面蓝图（与 onRetrieve 双写期并存，消费方优先用 surface） */
  onSurface?: (data: { surface: Surface }) => void
  onFinish?: (data: { messageId: string; suggestions: string[] }) => void
  onError?: (data: { message: string }) => void
}

export interface AiChatStreamParams {
  content: string
  sessionId?: string
  model?: string
  temperature?: number
  /** 深度思考（qwen thinking，输出 reasoning 流） */
  enableThinking?: boolean
}

/** 会话列表 */
export function fetchSessions(): Promise<{ list: AiSessionView[] }> {
  const { baseURL, url } = endpointOf('/sessions')
  return request<{ list: AiSessionView[] }>({ baseURL, url, method: 'get' })
}

/** 会话消息回放 */
export function fetchMessages(sessionId: string): Promise<{
  session: { id: string; title: string; updatedAt: string }
  messages: AiMessageView[]
}> {
  const { baseURL, url } = endpointOf(`/sessions/${sessionId}/messages`)
  return request({ baseURL, url, method: 'get' })
}

/** 删除会话（消息级联） */
export function deleteSession(sessionId: string): Promise<{ id: string }> {
  const { baseURL, url } = endpointOf(`/sessions/${sessionId}`)
  return request<{ id: string }>({ baseURL, url, method: 'delete' })
}

/** 清空对话（删消息保留会话壳） */
export function clearMessages(sessionId: string): Promise<{ id: string; cleared: boolean }> {
  const { baseURL, url } = endpointOf(`/sessions/${sessionId}/messages`)
  return request<{ id: string; cleared: boolean }>({ baseURL, url, method: 'delete' })
}

/**
 * Agent 流式对话（POST /ai/sessions/messages，v2：单通道 `data: {"type","data"}`）。
 * fetch + ReadableStream 逐帧解析（处理跨 chunk 粘包），signal 支持中断（离开页面/停止按钮）。
 */
export async function streamChat(
  params: AiChatStreamParams,
  handlers: AiStreamHandlers,
  signal?: AbortSignal,
): Promise<void> {
  const { url, authHeader } = rawCall('ai', '/sessions/messages')
  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
      ...(authHeader ? { Authorization: authHeader } : {}),
    },
    body: JSON.stringify(params),
    signal,
  })
  if (!resp.ok || !resp.body) {
    throw new Error(`AI 服务响应异常（${resp.status}）`)
  }

  const reader = resp.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  const dispatch = (frame: string): void => {
    const dataLine = frame.split('\n').find((l) => l.startsWith('data:'))
    if (!dataLine) return
    let payload: AiEventData
    try {
      payload = JSON.parse(dataLine.slice(5).trim()) as AiEventData
    } catch {
      return
    }
    const d = payload.data ?? {}
    switch (payload.type) {
      case 'start':
        handlers.onStart?.({ messageId: d.messageId ?? '' })
        break
      case 'data-session':
        if (d.sessionId) handlers.onSession?.({ sessionId: d.sessionId })
        break
      case 'start-step':
        handlers.onStartStep?.({ step: d.step ?? 0 })
        break
      case 'data-status':
        handlers.onStatus?.({ stage: d.stage ?? '', text: d.text ?? '' })
        break
      case 'data-plan':
        handlers.onPlan?.({ intent: d.intent ?? '', suggestedTerms: d.suggestedTerms ?? [] })
        break
      case 'data-retrieve':
        handlers.onRetrieve?.({
          query: d.query ?? '',
          items: d.items ?? [],
        })
        break
      case 'data-web-search':
        handlers.onWebSearch?.({ query: d.query ?? '', results: d.results ?? [] })
        break
      case 'data-graph':
        handlers.onGraph?.({
          query: d.query ?? '',
          entities: d.entities ?? [],
          relations: d.relations ?? [],
        })
        break
      case 'data-memory':
        handlers.onMemory?.({ memories: d.memories ?? [] })
        break
      case 'reasoning-start':
        handlers.onReasoningStart?.({ id: d.id ?? '' })
        break
      case 'reasoning-delta':
        handlers.onReasoningDelta?.({ id: d.id ?? '', delta: d.delta ?? '' })
        break
      case 'reasoning-end':
        handlers.onReasoningEnd?.({ id: d.id ?? '' })
        break
      case 'text-delta':
        handlers.onTextDelta?.({ id: d.id ?? '', delta: d.delta ?? '' })
        break
      case 'data-sources':
        handlers.onSources?.({ sources: d.sources ?? [] })
        break
      case 'data-surface':
        // 后端校验不通过时不会下发该事件，所以这里拿到的一定是裁剪干净的 surface
        if (d.surface) handlers.onSurface?.({ surface: d.surface })
        break
      case 'finish':
        handlers.onFinish?.({ messageId: d.messageId ?? '', suggestions: d.suggestions ?? [] })
        break
      case 'error':
        handlers.onError?.({ message: d.message ?? '' })
        break
      default:
        break
    }
  }

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    let sep = buffer.indexOf('\n\n')
    while (sep >= 0) {
      const frame = buffer.slice(0, sep)
      buffer = buffer.slice(sep + 2)
      if (frame.trim()) dispatch(frame)
      sep = buffer.indexOf('\n\n')
    }
  }
}

/** ai 资源端点（REST 走统一 request；流式经 rawCall 复用通道与鉴权） */
function endpointOf(suffix: string): { baseURL: string; url: string } {
  return endpoint('ai', suffix)
}
