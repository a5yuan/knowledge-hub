import { http, type HttpResponse, type DefaultBodyType } from 'msw'
import type { Announcement, Category, Tag, User } from '@/types/api'
import { db, getViewer, nextId, paginate } from '../db'
import { fail, forbidden, numParam, ok, unauthorized, withLatency } from './utils'

const NOT_FOUND = 1400

/** admin 端点统一守卫：未登录 401，非管理员 403 */
function requireAdmin(request: Request): { viewer: User } | { response: HttpResponse<DefaultBodyType> } {
  const viewer = getViewer(request)
  if (!viewer) return { response: unauthorized() }
  if (viewer.role !== 'admin') return { response: forbidden() }
  return { viewer }
}

export const adminHandlers = [
  // ---------- 操作日志 ----------
  // 登录即可读（spec §5.4：近期操作记录位于全员可见的首页大盘；管理端列表复用同端点）
  http.get('/api/operations', async ({ request }) => {
    await withLatency(100)
    if (!getViewer(request)) return unauthorized()
    const url = new URL(request.url)
    const page = paginate(db.operations, { page: numParam(url, 'page', 1), pageSize: numParam(url, 'pageSize', 10) })
    const list = page.list.map((op) => ({
      ...op,
      userName: db.users.find((u) => u.id === op.userId)?.displayName ?? '未知',
    }))
    return ok({ ...page, list })
  }),

  // ---------- 用户管理 ----------
  http.get('/api/users', async ({ request }) => {
    await withLatency()
    const guard = requireAdmin(request)
    if ('response' in guard) return guard.response
    const url = new URL(request.url)
    const keyword = url.searchParams.get('keyword')?.trim().toLowerCase()
    const role = url.searchParams.get('role')
    const departmentId = url.searchParams.get('departmentId')
    const status = url.searchParams.get('status')
    const filtered = db.users.filter((u) => {
      if (keyword && !`${u.username} ${u.displayName}`.toLowerCase().includes(keyword)) return false
      if (role && u.role !== role) return false
      if (departmentId && u.departmentId !== departmentId) return false
      if (status && u.status !== status) return false
      return true
    })
    const page = paginate(filtered, { page: numParam(url, 'page', 1), pageSize: numParam(url, 'pageSize', 20) })
    const list = page.list.map((u) => {
      const { password: _pw, ...pub } = u
      return { ...pub, departmentName: db.departments.find((d) => d.id === u.departmentId)?.name ?? '' }
    })
    return ok({ ...page, list })
  }),

  http.post('/api/users', async ({ request }) => {
    await withLatency()
    const guard = requireAdmin(request)
    if ('response' in guard) return guard.response
    const body = (await request.json()) as Pick<User, 'username' | 'displayName' | 'role' | 'departmentId'> & { password?: string }
    if (!body.username?.trim() || !body.displayName?.trim()) return fail(1410, '用户名与姓名不能为空')
    if (db.users.some((u) => u.username === body.username.trim())) return fail(1411, '用户名已存在')
    const user: User = {
      id: nextId('u'),
      username: body.username.trim(),
      password: body.password?.trim() || '123456',
      displayName: body.displayName.trim(),
      role: body.role ?? 'member',
      departmentId: body.departmentId ?? db.departments[0].id,
      status: 'active',
      createdAt: new Date().toISOString(),
    }
    db.users.push(user)
    const { password: _pw, ...pub } = user
    return ok(pub)
  }),

  http.patch('/api/users/:id', async ({ request, params }) => {
    await withLatency()
    const guard = requireAdmin(request)
    if ('response' in guard) return guard.response
    const admin = guard.viewer
    const user = db.users.find((u) => u.id === params.id)
    if (!user) return fail(NOT_FOUND, '用户不存在')
    const body = (await request.json()) as Partial<Pick<User, 'role' | 'departmentId' | 'status' | 'displayName'>> & { password?: string }
    if (body.status === 'disabled' && user.id === admin.id) return fail(1412, '不能禁用自己')
    // 与 DELETE 1414 同意图：阻止系统失去最后一名管理员（降级路径）
    if (body.role && body.role !== 'admin' && user.role === 'admin' && db.users.filter((u) => u.role === 'admin').length === 1) {
      return fail(1415, '不能降级最后一名管理员')
    }
    if (body.displayName?.trim()) user.displayName = body.displayName.trim()
    if (body.role) user.role = body.role
    if (body.departmentId) user.departmentId = body.departmentId
    if (body.status) user.status = body.status
    if (body.password?.trim()) user.password = body.password.trim()
    const { password: _pw, ...pub } = user
    return ok(pub)
  }),

  http.delete('/api/users/:id', async ({ request, params }) => {
    await withLatency()
    const guard = requireAdmin(request)
    if ('response' in guard) return guard.response
    const admin = guard.viewer
    const user = db.users.find((u) => u.id === params.id)
    if (!user) return fail(NOT_FOUND, '用户不存在')
    if (user.id === admin.id) return fail(1413, '不能删除当前登录账号')
    if (user.role === 'admin' && db.users.filter((u) => u.role === 'admin').length === 1) {
      return fail(1414, '该用户是最后一名管理员，不可删除')
    }
    db.users.splice(db.users.indexOf(user), 1)
    return ok({ id: user.id })
  }),

  // ---------- 部门（登录即可读：用户管理下拉/个人中心资料展示） ----------
  http.get('/api/departments', async ({ request }) => {
    await withLatency(60)
    if (!getViewer(request)) return unauthorized()
    return ok([...db.departments])
  }),

  // ---------- 分类管理 ----------
  http.get('/api/categories', async () => {
    await withLatency(60)
    return ok([...db.categories].sort((a, b) => a.sort - b.sort))
  }),

  http.post('/api/categories', async ({ request }) => {
    await withLatency()
    const guard = requireAdmin(request)
    if ('response' in guard) return guard.response
    const body = (await request.json()) as Pick<Category, 'key' | 'name'> & { sort?: number }
    if (!body.key?.trim() || !body.name?.trim()) return fail(1420, '分类标识与名称不能为空')
    if (db.categories.some((c) => c.key === body.key.trim())) return fail(1421, '分类标识已存在')
    const category: Category = {
      id: nextId('cat'),
      key: body.key.trim(),
      name: body.name.trim(),
      enabled: true,
      sort: body.sort ?? db.categories.length + 1,
    }
    db.categories.push(category)
    return ok(category)
  }),

  // ---------- 标签管理 ----------
  http.get('/api/tags', async () => {
    await withLatency(60)
    return ok(db.tags)
  }),

  http.post('/api/tags', async ({ request }) => {
    await withLatency()
    if (!getViewer(request)) return unauthorized() // 标签自由创建：成员也可在新建文档时添加
    const body = (await request.json()) as Pick<Tag, 'name'>
    const name = body.name?.trim()
    if (!name) return fail(1430, '标签名不能为空')
    const existed = db.tags.find((t) => t.name === name)
    if (existed) return ok(existed)
    const tag: Tag = { id: nextId('t'), name }
    db.tags.push(tag)
    return ok(tag)
  }),

  // ---------- 系统公告 ----------
  http.get('/api/announcements', async ({ request }) => {
    await withLatency(60)
    const url = new URL(request.url)
    const onlyEnabled = url.searchParams.get('enabled') === 'true'
    const list = db.announcements
      .filter((a) => (onlyEnabled ? a.enabled : true))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    return ok(list)
  }),

  http.post('/api/announcements', async ({ request }) => {
    await withLatency()
    const guard = requireAdmin(request)
    if ('response' in guard) return guard.response
    const body = (await request.json()) as Pick<Announcement, 'title' | 'content'>
    if (!body.title?.trim()) return fail(1440, '公告标题不能为空')
    const announcement: Announcement = {
      id: nextId('an'),
      title: body.title.trim(),
      content: body.content?.trim() ?? '',
      enabled: true,
      createdAt: new Date().toISOString(),
    }
    db.announcements.unshift(announcement)
    return ok(announcement)
  }),

  http.patch('/api/announcements/:id', async ({ request, params }) => {
    await withLatency()
    const guard = requireAdmin(request)
    if ('response' in guard) return guard.response
    const announcement = db.announcements.find((a) => a.id === params.id)
    if (!announcement) return fail(NOT_FOUND, '公告不存在')
    const body = (await request.json()) as Partial<Pick<Announcement, 'title' | 'content' | 'enabled'>>
    if (body.title?.trim()) announcement.title = body.title.trim()
    if (body.content !== undefined) announcement.content = body.content
    if (body.enabled !== undefined) announcement.enabled = body.enabled
    return ok(announcement)
  }),
]
