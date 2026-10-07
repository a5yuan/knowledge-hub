import { http } from 'msw'
import type { DocZone, Folder } from '@/types/api'
import { db, getViewer, nextId } from '../db'
import { fail, forbidden, ok, unauthorized, withLatency } from './utils'

export function zoneOfFolder(folderId: string | null): DocZone {
  if (!folderId) return 'mine'
  // 按文件夹记录的 zone 判定（seed 与新建文件夹统一走此口径，避免前缀推断误判新 id）
  return db.folders.find((f) => f.id === folderId)?.zone ?? 'mine'
}

/** 各分区可见的根文件夹范围（spec §5.2 四分区） */
function visibleFolders(zone: DocZone, viewerId: string, departmentId: string): Folder[] {
  return db.folders.filter((f) => {
    if (f.zone !== zone) return false
    if (zone === 'mine') return f.ownerId === viewerId
    if (zone === 'department') return f.departmentId === departmentId || f.departmentId === null
    return true
  })
}

export const folderHandlers = [
  http.get('/api/folders', async ({ request }) => {
    await withLatency(80)
    const viewer = getViewer(request)
    if (!viewer) return unauthorized()
    const url = new URL(request.url)
    const zone = (url.searchParams.get('zone') ?? 'mine') as DocZone
    const parentId = url.searchParams.get('parentId')
    let list = visibleFolders(zone, viewer.id, viewer.departmentId)
    if (parentId) list = list.filter((f) => f.parentId === parentId)
    return ok(list)
  }),

  http.post('/api/folders', async ({ request }) => {
    await withLatency()
    const viewer = getViewer(request)
    if (!viewer) return unauthorized()
    const body = (await request.json()) as { name: string; zone: DocZone; parentId?: string | null }
    if (!body.name?.trim()) return fail(1200, '文件夹名称不能为空')
    const folder: Folder = {
      id: nextId('f'),
      name: body.name.trim(),
      parentId: body.parentId ?? null,
      zone: body.zone,
      ownerId: body.zone === 'mine' ? viewer.id : null,
      departmentId: body.zone === 'department' ? viewer.departmentId : null,
    }
    db.folders.push(folder)
    return ok(folder)
  }),

  http.patch('/api/folders/:id', async ({ request, params }) => {
    await withLatency()
    const viewer = getViewer(request)
    if (!viewer) return unauthorized()
    const folder = db.folders.find((f) => f.id === params.id)
    if (!folder) return fail(1202, '文件夹不存在')
    if (folder.zone === 'mine' && folder.ownerId !== viewer.id && viewer.role !== 'admin') {
      return forbidden()
    }
    const body = (await request.json()) as { name?: string }
    if (body.name?.trim()) folder.name = body.name.trim()
    return ok(folder)
  }),

  http.delete('/api/folders/:id', async ({ request, params }) => {
    await withLatency()
    const viewer = getViewer(request)
    if (!viewer) return unauthorized()
    const folder = db.folders.find((f) => f.id === params.id)
    if (!folder) return fail(1202, '文件夹不存在')
    if (folder.zone === 'mine' && folder.ownerId !== viewer.id && viewer.role !== 'admin') {
      return forbidden()
    }
    const hasChildren = db.folders.some((f) => f.parentId === folder.id)
    const hasDocs = db.documents.some((d) => d.folderId === folder.id && d.archivedAt == null)
    if (hasChildren || hasDocs) return fail(1201, '文件夹非空，请先清空其中的内容')
    db.folders = db.folders.filter((f) => f.id !== folder.id)
    return ok({ id: folder.id })
  }),
]
