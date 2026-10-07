---
status: current
updated: 2026-09-19
---

# 双通道混合模式：/api Mock 保留地 + /real 真实后端，字段映射收敛到 src/api/adapters/

联调时后端仅覆盖 auth / document / search 三个域，且形态系统性不同（snake_case 字段、无响应包装、路径单数、无部门/目录/统计接口）。整体切到真实后端会让无后端域的页面全部失效，整体留在 Mock 则联调无从谈起。我们决定采用**双通道混合模式**：`baseURL` 同时编码「通道」与「响应形状」——`/api` 是 MSW 拦截的 Mock 保留地（永不配置代理），`/real` 由 Vite 代理到真实后端（`/real` 与 `/storage` 两个前缀，proxy rewrite 剥前缀）。通道决策收敛在 `src/api/endpoint.ts` 的 `DEFAULT_MODE` 资源模式表（auth/documents/search: real，其余 mock），并以 `endpoint(resource, suffix, modeOverride?)` 第三参支持个别端点钉死通道（如 `fetchHotSearch` 恒走 Mock）。**混合模式的黏合剂是会话桥**（`src/mocks/identity.ts`）：真实登录用户被镜像进 Mock 内存库并签发 Mock token，使 Mock 端点组在真实登录态下依旧可用。

**snake_case 红线**：后端字段名（`parse_state` / `is_public` / `author_id` / `source_file_url`…）只允许出现在 `src/api/adapters/` 一个目录内。API 模块在 adapter 完成后端字段 → 领域类型（`src/types/api.ts`）的翻译，视图层与 API 模块签名零感知。这是 ADR-0003「组件只依赖 src/api/」在联调期的具体化——若视图出现 snake_case，隔离即告失守。

**混合模式的适用边界**：数据可单域供给的页面走真实通道（登录/文档管理/搜索/审核工作台）；数据由无后端接口聚合的页面（首页大盘、系统管理、个人中心的存储统计）整页或局部保持 Mock，并**显式标注「演示数据」**，不允许 Mock 数字冒充真实指标。无法映射的字段（ownerName/fileSize 等）在 UI 显式降级为「—」或隐藏并给出说明，不允许空占位误导。

## Consequences

- **拆包确定性**：`normalizeResponse` 按通道选择拆包规则（Mock 信封 `{code,data,message}` vs 后端裸对象 + Nest 错误体），错误归一 `toApiError`（正数=Mock 业务码，负数=-HTTP 状态码），调用方只面对统一的 `ApiError`
- **运维逃生舱**：`localStorage['kh_api_mode'] = {"resource":"mock"}` 可单资源回退 Mock，用于后端故障时保住演示——它是运维工具而非功能开关，不写进任何 UI
- **鉴权双键并存**：`/real` 用 access token，`/api` 用 mock token（回落 kh_token）；四会话键由 `src/api/session.ts` 统一管理，401 → 单飞刷新 → 重放一次（`src/api/refresh.ts` + http.ts 拦截器）
- **后端加全局前缀的义务**：若未来加 `setGlobalPrefix('api')`，前端只需改 `endpoint.ts` 的 `REAL_ROOT` 一处，但**必须先通知前端**
- **重放与降级并发**：部分后端缺口（多文件上传、归档恢复、排序、筛选）以补偿请求或 UI 降级规避，规避清单与待后端项见 `backend-integration/`（spec §5 与 backend-todo.md）
