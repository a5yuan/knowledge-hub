import { request } from './http'
import type { Category } from '@/types/api'

export function fetchCategories(): Promise<Category[]> {
  return request<Category[]>({ url: '/categories', method: 'get' })
}

export function createCategory(payload: { key: string; name: string; sort?: number }): Promise<Category> {
  return request<Category>({ url: '/categories', method: 'post', data: payload })
}
