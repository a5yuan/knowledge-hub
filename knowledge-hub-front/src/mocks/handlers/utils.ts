import { HttpResponse, delay } from 'msw'
import type { DefaultBodyType } from 'msw'
import type { ApiResponse } from '@/types/api'

/**
 * 响应助手统一返回 HttpResponse（宽松类型）：
 * MSW v2 会推断 handler 内所有分支的联合类型，过紧的泛型会导致分支间互斥报错。
 */

export function ok<T>(data: T, message = 'ok'): HttpResponse<DefaultBodyType> {
  return HttpResponse.json({ code: 0, data, message } satisfies ApiResponse<T>)
}

/** 业务错误：HTTP 200 + code !== 0，前端 request() 统一抛 ApiError */
export function fail(code: number, message: string): HttpResponse<DefaultBodyType> {
  return HttpResponse.json({ code, data: null, message } satisfies ApiResponse<null>)
}

export function unauthorized(): HttpResponse<DefaultBodyType> {
  return HttpResponse.json({ code: 401, data: null, message: '未登录或登录已过期' }, { status: 401 })
}

export function forbidden(): HttpResponse<DefaultBodyType> {
  return HttpResponse.json({ code: 403, data: null, message: '无权限执行此操作' }, { status: 403 })
}

/** 模拟网络与解析延迟 */
export async function withLatency(ms = 120 + Math.random() * 180): Promise<void> {
  await delay(ms)
}

export function numParam(url: URL, key: string, fallback: number): number {
  const raw = url.searchParams.get(key)
  const parsed = raw ? Number(raw) : NaN
  return Number.isFinite(parsed) ? parsed : fallback
}
