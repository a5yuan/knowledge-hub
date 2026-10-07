/**
 * 资源模式表 + 双通道路径决策（spec §3.2 硬约束 1）。
 *
 * 任何 API 模块不得写字面量路径，一律经 endpoint(resource, suffix) 取得 { baseURL, url }。
 * - baseURL 编码「走哪个通道」：/api = Mock，/real = 真实后端
 * - url 编码「资源路径」：Mock 用复数（/documents），真实用单数（/document）—— 复数→单数重写留在代码常量内
 *
 * 逃生舱：localStorage['kh_api_mode'] 可单资源回退 Mock，无需改代码重启。
 */
import { getAccessToken, getMockToken } from './session'

/** 通道前缀 */
const MOCK_BASE = '/api'
const REAL_BASE = '/real'

/** 真实后端路径重写表：前端复数资源名 → 后端单数路径 */
const REAL_ROOT: Record<string, string> = {
  documents: '/document',
  auth: '/auth',
  search: '/search',
  roles: '/role',
  graphs: '/kg',
  ai: '/ai',
  // 以下资源后端未实现，真实通道不会命中（endpoint 返回 mock 通道）
  folders: '/folders',
  users: '/users',
  stats: '/stats',
  categories: '/categories',
  tags: '/tags',
  announcements: '/announcements',
  operations: '/operations',
}

/** 资源名枚举（与 src/api/ 下模块文件一一对应） */
export type ResourceName = keyof typeof REAL_ROOT

/**
 * 资源默认通道：'real' = 走真实后端，'mock' = 走 MSW。
 * 工单 01 仅切 auth（登录与 /auth/me，验证通道成立）；documents 归工单 03、search 归工单 04，
 * 切换时只改本表，不改 Vite 代理。
 */
const DEFAULT_MODE: Record<ResourceName, 'real' | 'mock'> = {
  auth: 'real',
  documents: 'real',
  search: 'real',
  roles: 'real',
  graphs: 'real',
  ai: 'real',
  folders: 'mock',
  users: 'mock',
  stats: 'mock',
  categories: 'mock',
  tags: 'mock',
  announcements: 'mock',
  operations: 'mock',
}

/** 逃生舱：读取 localStorage 单资源覆盖 */
function getOverrideMode(resource: ResourceName): 'real' | 'mock' | null {
  try {
    const raw = localStorage.getItem('kh_api_mode')
    if (!raw) return null
    const map = JSON.parse(raw) as Record<string, 'real' | 'mock'>
    return map[resource] ?? null
  } catch {
    return null
  }
}

function modeOf(resource: ResourceName): 'real' | 'mock' {
  return getOverrideMode(resource) ?? DEFAULT_MODE[resource]
}

/** 判断一个 axios config 是否走真实通道（spec §3.2 硬约束 5：拆包决策源） */
export function isReal(config: { baseURL?: string } | undefined): boolean {
  return config?.baseURL === REAL_BASE
}

/** 资源当前是否走真实通道（视图层降级判定用，含 kh_api_mode 逃生舱） */
export function isRealResource(resource: ResourceName): boolean {
  return modeOf(resource) === 'real'
}

/**
 * 取得某资源的通道与路径。
 * @param resource     资源名（如 'documents'）
 * @param suffix       路径后缀（如 '/123'、'/upload'）
 * @param modeOverride 强制通道：后端未实现的接口（如 auth/profile）需显式钉在 Mock 通道（spec 工单 02）
 * @returns { baseURL, url } —— 直接展开进 axios config 即可
 */
export function endpoint(
  resource: ResourceName,
  suffix = '',
  modeOverride?: 'real' | 'mock',
): { baseURL: string; url: string } {
  const real = (modeOverride ?? modeOf(resource)) === 'real'
  if (real) {
    const root = REAL_ROOT[resource] ?? `/${resource}`
    return { baseURL: REAL_BASE, url: `${root}${suffix}` }
  }
  return { baseURL: MOCK_BASE, url: `/${resource}${suffix}` }
}

/**
 * 取得某资源的 Authorization header 值。
 * 真实通道用 access token；Mock 通道优先 mock token（会话桥签发），回落 access token
 * （纯 Mock 会话登录时 kh_token 本身就是 mock token，kh_mock_token 为空）。
 */
export function authHeaderFor(resource: ResourceName): string | null {
  const token = modeOf(resource) === 'real' ? getAccessToken() : (getMockToken() ?? getAccessToken())
  return token ? `Bearer ${token}` : null
}

/**
 * 供 keepalive fetch 复用通道与鉴权决策（Editor.vue 的 beforeunload 兜底）。
 * 返回完整 URL（baseURL + url）与 Authorization header。
 */
export function rawCall(resource: ResourceName, suffix = ''): { url: string; authHeader: string | null } {
  const { baseURL, url } = endpoint(resource, suffix)
  return { url: `${baseURL}${url}`, authHeader: authHeaderFor(resource) }
}
