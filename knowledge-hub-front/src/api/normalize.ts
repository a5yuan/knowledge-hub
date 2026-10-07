/**
 * 响应归一与错误归一（spec §3.4）。
 *
 * normalizeResponse：按 response.config.baseURL 确定性拆包 ——
 * - Mock 通道（/api）：{ code, data, message } 包络，code !== 0 抛 ApiError（正数业务码）
 * - 真实通道（/real）：裸业务对象，2xx body 即 data；附 HTML 守卫（代理失效时 dev server
 *   会回 SPA fallback 的 index.html，必须明确报错而不是把 HTML 当数据吞下）
 *
 * toApiError：正数 = Mock 业务码；负数 = -HTTP 状态码；正负不相撞。
 */
import type { AxiosError, AxiosResponse } from 'axios'
import type { ApiResponse } from '@/types/api'
import { isReal } from './endpoint'

export class ApiError extends Error {
  code: number

  constructor(code: number, message: string) {
    super(message)
    this.code = code
    this.name = 'ApiError'
  }
}

/** Nest 的 message 为数组（ValidationPipe 失败）时按「；」拼接 */
function joinMessage(message: unknown): string {
  return Array.isArray(message) ? message.join('；') : ''
}

/** HTML 守卫：真实通道响应必须是 JSON，text/html 说明代理失效落到 SPA fallback */
function guardHtml(raw: AxiosResponse): void {
  const contentType = String(raw.headers?.['content-type'] ?? '')
  if (contentType.includes('text/html')) {
    throw new ApiError(-1, '响应格式异常：真实通道返回了 HTML 而非 JSON（请检查后端是否已启动、/real 代理是否生效）')
  }
}

/** 拆包：request<T>() 的唯一出口；从 raw.config 取 baseURL 确定性分流 */
export function normalizeResponse<T>(raw: AxiosResponse): T {
  if (isReal(raw.config)) {
    guardHtml(raw)
    return raw.data as T
  }
  const envelope = raw.data as ApiResponse<T>
  if (envelope.code !== 0) {
    throw new ApiError(envelope.code, joinMessage(envelope.message) || envelope.message || '操作失败')
  }
  return envelope.data
}

/** axios 错误 → ApiError：真实通道 -status，Mock 未授权 401（正数），无响应 -1 */
export function toApiError(error: AxiosError): ApiError {
  const status = error.response?.status
  const payload = error.response?.data as Partial<ApiResponse<unknown>> | undefined
  const message = joinMessage(payload?.message) || (typeof payload?.message === 'string' ? payload.message : '')
  if (status === 401 && !isReal(error.config)) {
    // Mock 未授权：HTTP 401 + code 401，归一为正数业务码
    return new ApiError(401, message || '未登录或登录已过期')
  }
  if (status) {
    return new ApiError(-status, message || `请求失败（HTTP ${status}）`)
  }
  return new ApiError(-1, '网络异常，请稍后重试')
}
