import type { HttpHandler } from 'msw'
import { authHandlers } from './auth'
import { folderHandlers } from './folders'
import { documentHandlers } from './documents'
import { searchHandlers } from './search'
import { statsHandlers } from './stats'
import { adminHandlers } from './admin'

/** spec §7 全部端点的 mock 实现（搜索历史除外：走前端 localStorage，见 spec §8） */
export const handlers: HttpHandler[] = [
  ...authHandlers,
  ...folderHandlers,
  ...documentHandlers,
  ...searchHandlers,
  ...statsHandlers,
  ...adminHandlers,
]
