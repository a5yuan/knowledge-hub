# 03 登录认证与路由守卫

Status: done
Blocked by: 02
Spec: §5.1、§2 角色定义

## 目标

账号密码 + JWT 的完整认证链路，角色驱动的菜单与路由访问控制。

## 范围

- 登录页（风格对齐原型视觉：蓝色主色卡片式）
- `POST /auth/login` 对接，token + user 存 Pinia + localStorage
- axios 请求拦截器附 token、401 响应拦截器跳登录
- 路由守卫：未登录访问受保护路由 → 重定向登录页；登录后访问登录页 → 跳首页
- 系统管理路由 + 菜单按 `role=admin` 显隐（替换 01 的本地模拟）
- 退出登录（清空态，回登录页）

## 验收标准

- [x] 未登录访问任意受保护页跳登录页
- [x] member 登录看不到系统管理入口，直接输 URL 也被守卫拦截
- [x] admin 登录可见系统管理
- [x] 401 场景（手动清 token 调接口）自动回登录页

## Comments

- 2026-09-04 完成并验收通过。
- 实现分层：登录页 `views/login/Index.vue`（蓝色卡片式 + 表单校验 + 演示账号提示 + 站内 redirect 防开放重定向）→ `stores/user.ts`（token 存 localStorage、user 存 Pinia，`restoreSession` 单飞恢复会话）→ `router` 全局守卫（会话恢复 → 登录校验 → admin 角色校验）→ `api/http.ts` 401 拦截（清凭证 + 动态 import router 跳登录，避免循环依赖）。
- **对工单 02 的内部修正**：mock token 从 sessions 表改为自包含格式 `mock_<userId>_<ts>`（模拟无状态 JWT，spec §5.1）。原因：sessions 是内存态，页面刷新即丢但 token 持久在 localStorage，会导致每次刷新必然 401；自包含 token 对齐真实 JWT 行为，顺带删除 sessions 表。签名校验属真实后端职责。
- **main.ts 时序修正**：MSW worker 必须先于 `app.use(router)` 就绪，否则首次路由守卫的 `/auth/me` 会绕过 mock 直打 dev server。
- admin 接口守卫：`requireAdmin` 区分 401（未登录）/403（非管理员）；`GET /api/operations` 补了 admin 守卫（此前公开，属系统管理资源）。
- 浏览器实测四场景全部通过；另验证有效 token 刷新后会话恢复（李成员态保持）。vue-tsc 与 vite build 均 exit 0。
- 已知构建提示（无碍）：router 被 http.ts 动态引入又被 main.ts 静态引入，Vite 提示不会拆分 chunk——模块本就属于主包，行为正确。
