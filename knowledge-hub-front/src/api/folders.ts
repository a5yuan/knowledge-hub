import { request } from './http'
import { endpoint, isReal } from './endpoint'
import { adapt } from './adapt'
import {
  isFolderZone,
  mapFolder,
  toBackendCreateBody,
  toBackendFolderQuery,
  toBackendRenameBody,
  type BackendFolder,
} from './adapters/folder'
import type { DocFolderZone, DocZone, Folder } from '@/types/api'

/**
 * 目录 API（16 号工单）。
 * 双通道：Mock 保持既有 camelCase 契约不动；真实通道经 adapter 转 snake_case。
 * 所有函数一律经 endpoint('folders', ...) 取路径，不写字面量。
 */

/** 新建目录载荷（视图层 camelCase） */
export interface FolderCreatePayload {
  name: string
  zone: DocFolderZone
  parentId?: string | null
}

/**
 * 目录列表。
 * - 真实通道下 zone 必须是三个真分区之一；archive 直接返回空数组，不发起请求（否则后端 DTO 校验 400）
 * - 不传 parentId 时后端返回该分区下全部未删目录 —— Index.vue 的 buildFolderTree 需要完整节点集
 */
export async function fetchFolders(params: {
  zone: DocZone
  parentId?: string
}): Promise<Folder[]> {
  const { baseURL, url } = endpoint('folders')
  const real = isReal({ baseURL })
  if (real && !isFolderZone(params.zone)) return []
  const config = {
    baseURL,
    url,
    method: 'get' as const,
    params: real ? toBackendFolderQuery(params) : params,
  }
  const raw = await request<BackendFolder[] | Folder[]>(config)
  return adapt<Folder[], BackendFolder[]>(config, raw, (list) => (list ?? []).map(mapFolder))
}

/** 新建目录：parentId 缺省不传，由后端落 '0'（根） */
export async function createFolder(payload: FolderCreatePayload): Promise<Folder> {
  const { baseURL, url } = endpoint('folders')
  const config = { baseURL, url, method: 'post' as const }
  const raw = await request<BackendFolder | Folder>({
    ...config,
    data: isReal({ baseURL }) ? toBackendCreateBody(payload) : payload,
  })
  return adapt<Folder, BackendFolder>(config, raw, mapFolder)
}

/** 重命名目录 */
export async function renameFolder(id: string, name: string): Promise<Folder> {
  const { baseURL, url } = endpoint('folders', `/${id}`)
  const config = { baseURL, url, method: 'patch' as const }
  const raw = await request<BackendFolder | Folder>({
    ...config,
    data: isReal({ baseURL }) ? toBackendRenameBody(name) : { name },
  })
  return adapt<Folder, BackendFolder>(config, raw, mapFolder)
}

/**
 * 删除目录（软删）。
 * 有子目录或有文档挂载时后端返回 400，message 为中文提示，由 http 层包装为 ApiError 抛出。
 */
export async function deleteFolder(id: string): Promise<{ id: string }> {
  const { baseURL, url } = endpoint('folders', `/${id}`)
  const raw = await request<{ id: string }>({ baseURL, url, method: 'delete' })
  return { id: raw?.id ?? id }
}
