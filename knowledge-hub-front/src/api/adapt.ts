/**
 * 双通道字段适配入口（spec §3.2 硬约束 1）。
 * 真实通道执行 mapper（snake_case → camelCase 等映射），Mock 通道数据原样返回。
 */
import type { AxiosRequestConfig } from 'axios'
import { isReal } from './endpoint'

export function adapt<TMock, TReal>(
  config: AxiosRequestConfig | { baseURL: string; url: string },
  raw: TMock | TReal,
  mapper: (real: TReal) => TMock,
): TMock {
  return isReal(config) ? mapper(raw as TReal) : (raw as TMock)
}
