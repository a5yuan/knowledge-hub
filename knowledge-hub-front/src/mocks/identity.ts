/**
 * 会话桥（spec §3.3）：把真实登录用户镜像进 Mock 内存库并签发 mock_<userId>_<ts> token，
 * 使 /api Mock 端点组在真实登录态下仍可用（getViewer() 要求 token 以 mock_ 开头）。
 *
 * getViewer() 与全部 Mock handler 不改 —— 桥只做两件事：
 * 1. 保证 db.users 中存在对应用户（同名 seed 用户就地同步；真实独有账号动态建一条，部门兜底）
 * 2. 签发 mock token 存入 kh_mock_token（http.ts 请求拦截对 /api 通道优先使用）
 *
 * 调用点两处缺一不可：stores/user.ts 的 login() 之后、restoreSession() 之后
 * （页面刷新后 Mock 内存库重建，必须重新镜像）。
 */
import type { PublicUser } from '@/types/api'
import { db } from './db'
import { setMockToken } from '@/api/session'

/** 后端 AuthUser 无部门字段，兜底 seed 首个部门保证 canSeeDocument 部门分支可用（有损，spec §4.4） */
const FALLBACK_DEPARTMENT_ID = 'd-rd'

export function bridgeSession(user: PublicUser): void {
  let mirrored = db.users.find((u) => u.username === user.username)
  if (mirrored) {
    // 同名 seed 用户（如 admin）：保留其 id —— seed 文档的 ownerId 指向它，同步展示名与角色即可
    mirrored.displayName = user.displayName || mirrored.displayName
    mirrored.role = user.role
  } else {
    mirrored = {
      id: `u-real-${user.id}`,
      username: user.username,
      password: '',
      displayName: user.displayName || user.username,
      role: user.role,
      departmentId: FALLBACK_DEPARTMENT_ID,
      status: 'active',
      createdAt: '',
    }
    db.users.push(mirrored)
  }
  setMockToken(`mock_${mirrored.id}_${Date.now().toString(36)}`)
}
