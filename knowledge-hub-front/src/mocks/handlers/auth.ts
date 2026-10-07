import { http } from 'msw'
import type { LoginResult } from '@/types/api'
import { db, getViewer, logOperation, toPublicUser } from '../db'
import { fail, ok, unauthorized, withLatency } from './utils'

const WRONG_CREDENTIALS = 1001
const USER_DISABLED = 1002
const PROFILE_INVALID = 1003
const WRONG_OLD_PASSWORD = 1004

export const authHandlers = [
  http.post('/api/auth/login', async ({ request }) => {
    await withLatency()
    const body = (await request.json()) as { username?: string; password?: string }
    const user = db.users.find((u) => u.username === body.username)
    if (!user || user.password !== body.password) {
      return fail(WRONG_CREDENTIALS, '用户名或密码错误')
    }
    if (user.status === 'disabled') {
      return fail(USER_DISABLED, '账号已被禁用，请联系管理员')
    }
    const token = `mock_${user.id}_${Date.now().toString(36)}`
    logOperation({ userId: user.id, action: 'login', detail: '登录系统' })
    return ok<LoginResult>({ token, user: toPublicUser(user) })
  }),

  http.get('/api/auth/me', async ({ request }) => {
    await withLatency()
    const viewer = getViewer(request)
    if (!viewer) return unauthorized()
    return ok(toPublicUser(viewer))
  }),

  // ---------- 个人中心（工单 12）：登录用户维护自己的资料与密码 ----------
  http.patch('/api/auth/profile', async ({ request }) => {
    await withLatency()
    const viewer = getViewer(request)
    if (!viewer) return unauthorized()
    const body = (await request.json()) as { displayName?: string }
    if (!body.displayName?.trim()) return fail(PROFILE_INVALID, '昵称不能为空')
    viewer.displayName = body.displayName.trim()
    logOperation({ userId: viewer.id, action: 'update', detail: '修改个人资料' })
    return ok(toPublicUser(viewer))
  }),

  http.put('/api/auth/password', async ({ request }) => {
    await withLatency()
    const viewer = getViewer(request)
    if (!viewer) return unauthorized()
    const body = (await request.json()) as { oldPassword?: string; newPassword?: string }
    if (!body.oldPassword || !body.newPassword) return fail(PROFILE_INVALID, '旧密码与新密码不能为空')
    if (body.oldPassword !== viewer.password) return fail(WRONG_OLD_PASSWORD, '旧密码错误')
    if (body.newPassword.length < 6) return fail(PROFILE_INVALID, '新密码至少 6 位')
    if (body.newPassword === body.oldPassword) return fail(PROFILE_INVALID, '新密码不能与旧密码相同')
    viewer.password = body.newPassword
    return ok(null)
  }),
]
