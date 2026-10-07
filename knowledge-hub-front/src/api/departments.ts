import { request } from './http'
import type { Department } from '@/types/api'

export function fetchDepartments(): Promise<Department[]> {
  return request<Department[]>({ url: '/departments', method: 'get' })
}
