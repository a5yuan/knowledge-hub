import { request } from './http'
import type { DocZone, Folder } from '@/types/api'

export interface FolderCreatePayload {
  name: string
  zone: DocZone
  parentId?: string | null
}

export function fetchFolders(params: { zone: DocZone; parentId?: string }): Promise<Folder[]> {
  return request<Folder[]>({ url: '/folders', method: 'get', params })
}

export function createFolder(payload: FolderCreatePayload): Promise<Folder> {
  return request<Folder>({ url: '/folders', method: 'post', data: payload })
}

export function renameFolder(id: string, name: string): Promise<Folder> {
  return request<Folder>({ url: `/folders/${id}`, method: 'patch', data: { name } })
}

export function deleteFolder(id: string): Promise<{ id: string }> {
  return request<{ id: string }>({ url: `/folders/${id}`, method: 'delete' })
}
