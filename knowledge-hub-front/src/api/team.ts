import { request } from './http'
import { endpoint } from './endpoint'

/**
 * 团队模块 API（15 号工单）：后端 `/team` 接口组已完整实现（9 路由 + 4 权限码），
 * 本模块为纯前端接入，不做任何后端改动。
 *
 * snake_case 收敛线（ADR-0005）：后端字段名（team_name / team_code / leader_id /
 * parent_id / member_role / created_at / updated_at）只允许出现在本文件内。
 * 视图层与 types/api.ts 一律使用驼峰视图类型。
 */

/** 团队视图（后端 TeamView 归一） */
export interface TeamView {
  id: string
  /** ← team_name */
  name: string
  /** ← team_code */
  code: string | null
  description: string | null
  /** ← leader_id */
  leaderId: string | null
  /** ← parent_id（'0' 归一为 null，与 kh_team 的根哨兵约定一致） */
  parentId: string | null
  sort: number
  /** 0 禁用 1 启用 */
  status: number
  /** ← created_at */
  createdAt: string
  /** ← updated_at */
  updatedAt: string
}

/** 团队成员视图（后端 TeamMemberView 归一） */
export interface TeamMemberView {
  /** ← user_id */
  userId: string
  username: string
  /** ← realName（后端联 kh_user 返回，可能为空） */
  realName: string | null
  /** ← member_role */
  memberRole: TeamMemberRole
}

export type TeamMemberRole = 'leader' | 'member'

/** 后端原始响应（仅本文件使用） */
interface BackendTeam {
  id: string
  team_name: string
  team_code: string | null
  description: string | null
  leader_id: string | null
  parent_id: string
  sort: number
  status: number
  created_at: string
  updated_at: string
}

interface BackendTeamMember {
  userId: string
  username: string
  realName: string | null
  memberRole: TeamMemberRole
}

interface BackendPage<T> {
  items: T[]
  total: number
  page: number
  pageSize: number
}

/** 后端 → 视图归一：'0' 是后端的「根」哨兵，前端一律用 null */
function mapTeam(b: BackendTeam): TeamView {
  return {
    id: b.id,
    name: b.team_name,
    code: b.team_code,
    description: b.description,
    leaderId: b.leader_id,
    parentId: b.parent_id === '0' ? null : b.parent_id,
    sort: b.sort,
    status: b.status,
    createdAt: b.created_at,
    updatedAt: b.updated_at,
  }
}

function mapTeamMember(b: BackendTeamMember): TeamMemberView {
  return {
    userId: b.userId,
    username: b.username,
    realName: b.realName,
    memberRole: b.memberRole,
  }
}

/** 视图 → 后端：null 的 parentId 回写成 '0'（后端根哨兵） */
function toBackendPayload(payload: TeamUpsertPayload): Record<string, unknown> {
  const body: Record<string, unknown> = {}
  if (payload.name !== undefined) body.team_name = payload.name
  if (payload.code !== undefined) body.team_code = payload.code ?? undefined
  if (payload.description !== undefined) body.description = payload.description ?? undefined
  if (payload.leaderId !== undefined) body.leader_id = payload.leaderId ?? undefined
  if (payload.parentId !== undefined) body.parent_id = payload.parentId ?? '0'
  if (payload.sort !== undefined) body.sort = payload.sort
  return body
}

export interface TeamListQuery {
  name?: string
  code?: string
  leaderId?: string
  status?: number
  page?: number
  pageSize?: number
}

export interface TeamUpsertPayload {
  name?: string
  code?: string | null
  description?: string | null
  leaderId?: string | null
  parentId?: string | null
  sort?: number
}

export interface TeamPage {
  list: TeamView[]
  total: number
  page: number
  pageSize: number
}

/** 分页查询团队（后端 items→list 归一） */
export async function fetchTeams(query: TeamListQuery = {}): Promise<TeamPage> {
  const { baseURL, url } = endpoint('teams')
  const params: Record<string, unknown> = {}
  if (query.name !== undefined && query.name !== '') params.team_name = query.name
  if (query.code !== undefined && query.code !== '') params.team_code = query.code
  if (query.leaderId !== undefined && query.leaderId !== '') params.leader_id = query.leaderId
  if (query.status !== undefined) params.status = query.status
  if (query.page !== undefined) params.page = query.page
  if (query.pageSize !== undefined) params.pageSize = query.pageSize

  const res = await request<BackendPage<BackendTeam>>({ baseURL, url, method: 'get', params })
  return {
    list: (res.items ?? []).map(mapTeam),
    total: res.total ?? 0,
    page: res.page ?? 1,
    pageSize: res.pageSize ?? 20,
  }
}

/** 团队详情 */
export async function fetchTeam(id: string): Promise<TeamView> {
  const { baseURL, url } = endpoint('teams', `/${id}`)
  const res = await request<BackendTeam>({ baseURL, url, method: 'get' })
  return mapTeam(res)
}

/** 创建团队（leader_id 缺省为当前登录用户，由后端处理） */
export async function createTeam(payload: TeamUpsertPayload): Promise<TeamView> {
  const { baseURL, url } = endpoint('teams')
  const res = await request<BackendTeam>({ baseURL, url, method: 'post', data: toBackendPayload(payload) })
  return mapTeam(res)
}

/** 更新团队（部分更新） */
export async function updateTeam(id: string, payload: TeamUpsertPayload): Promise<TeamView> {
  const { baseURL, url } = endpoint('teams', `/${id}`)
  const res = await request<BackendTeam>({ baseURL, url, method: 'patch', data: toBackendPayload(payload) })
  return mapTeam(res)
}

/** 删除团队（需 team:delete 权限码；种子未授权任何角色，仅 Admin 旁路可删） */
export async function deleteTeam(id: string): Promise<{ id: string; message: string }> {
  const { baseURL, url } = endpoint('teams', `/${id}`)
  return request<{ id: string; message: string }>({ baseURL, url, method: 'delete' })
}

export interface TeamMemberMutationResult {
  teamId: string
  userId: string
  memberRole: TeamMemberRole
  message: string
}

/** 成员列表（联 kh_user 返回 username / realName） */
export async function fetchTeamMembers(teamId: string): Promise<TeamMemberView[]> {
  const { baseURL, url } = endpoint('teams', `/${teamId}/members`)
  const res = await request<BackendTeamMember[]>({ baseURL, url, method: 'get' })
  return (res ?? []).map(mapTeamMember)
}

/** 添加成员（重复添加后端返回 409） */
export async function addTeamMember(
  teamId: string,
  payload: { userId: string; memberRole?: TeamMemberRole },
): Promise<TeamMemberMutationResult> {
  const { baseURL, url } = endpoint('teams', `/${teamId}/members`)
  return request<TeamMemberMutationResult>({
    baseURL,
    url,
    method: 'post',
    data: { user_id: payload.userId, member_role: payload.memberRole },
  })
}

/** 调整成员角色（leader / member 互切） */
export async function updateMemberRole(
  teamId: string,
  userId: string,
  memberRole: TeamMemberRole,
): Promise<TeamMemberMutationResult> {
  const { baseURL, url } = endpoint('teams', `/${teamId}/members/${userId}`)
  return request<TeamMemberMutationResult>({
    baseURL,
    url,
    method: 'patch',
    data: { member_role: memberRole },
  })
}

/** 移除成员（关联行硬删） */
export async function removeTeamMember(
  teamId: string,
  userId: string,
): Promise<TeamMemberMutationResult> {
  const { baseURL, url } = endpoint('teams', `/${teamId}/members/${userId}`)
  return request<TeamMemberMutationResult>({ baseURL, url, method: 'delete' })
}
