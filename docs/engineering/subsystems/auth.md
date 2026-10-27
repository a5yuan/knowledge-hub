---
status: current
updated: 2026-10-27
---

# 子系统：认证与权限（`knowledge-hub-backend/src/auth/`）

改鉴权、角色、权限码之前必读。**本模块的坑以"能跑但权限错"为特征，不会报错。**

## 职责

**负责**：登录 / 双 Token 签发与刷新、邮箱激活、密码重置、三个全局 Guard、RBAC 权限码校验、用户自助操作（`UserService`）。

**不负责**：管理端的用户 CRUD（在 `user/`，类名刻意叫 `UserAdminService` 以区分）。

## 不变量

1. **所有接口默认需要登录**，用 `@Public()` 显式放行。
2. **三个全局 Guard 的注册顺序固定**（`auth.module.ts`，`APP_GUARD`）：
   `JwtAuthGuard`（验登录）→ `RolesGuard`（验角色）→ `PermissionsGuard`（验权限码）。
   顺序颠倒会让 `@Roles` / `@RequirePermission` 在无用户上下文时执行。
3. **`@RequirePermission` 是显式标注式，非全局强制。** 未标注的接口零开销放行 —— 意味着**漏标 = 接口裸奔**，不会有任何提示。
4. **`ROLE_ADMIN` 经 `PermissionsGuard` 旁路通过全部权限码。**
5. **权限码语义**：`permission_type = 1` 是菜单（必须有 `menu_url`），`2` 是按钮。

## 依赖方向

```
auth/ ──→ user/（避免：auth 内的 UserService 与 user/ 的 UserAdminService 同名不同模块）
      ──→ redis/（refresh token 存储）

所有模块 ──→ auth/decorators（@Public / @Roles / @CurrentUser / @RequirePermission）
          ──✗ 不直接依赖 auth/guards 的内部实现
```

## 关键文件

| 文件 | 作用 |
|---|---|
| `auth.module.ts` | `APP_GUARD` 三连注册、双 Token 配置 |
| `auth.service.ts` / `auth.controller.ts` | 登录、刷新、邮箱激活、密码重置 |
| `permission.service.ts` | `getUserPermissions()`：角色权限 ∪ 直赋权限 |
| `guards/jwt-auth.guard.ts` | 全局登录校验（配合 `@Public` 旁路） |
| `guards/permissions.guard.ts` | 权限码校验 + `ROLE_ADMIN` 旁路 |
| `decorators/*.ts` | 四个装饰器 |
| `strategies/jwt.strategy.ts` | JWT 解析 |

## 已知陷阱

### ⚠️ ROLE_ADMIN 的接口旁路 ≠ 菜单可见

`PermissionsGuard` 对 `ROLE_ADMIN` 放行全部权限码，但 `PermissionService.getUserPermissions()` **只做「角色权限 ∪ 直赋权限」，没有 admin 全量旁路**。

后果：新加的菜单码如果不写进 `kh_role_permission`，admin **调得动接口却看不到菜单**。（21 号工单踩过。）

### ⚠️ 前端菜单可见性只看菜单码，按钮码不能替代

子菜单可见性走 `system:*` **菜单码**，按钮渲染走 `v-permission` **按钮码**。两者不能互相替代 —— 只授按钮码，菜单不显示。

### ⚠️ 给非 Admin 角色授按钮码时，父菜单码不必同授，且往往不该授

`system:dept` 的父菜单是顶层 `system`，而 `ROLE_USER` 本就没有 `system` —— 单授子菜单码是**死码**。

此时按钮码只作「接口级能力码」存在（能调接口、看不到管理页），与 `team:*` 的既有约定一致。这是**有意设计，不是 bug**。

### ⚠️ 权限码 ID 不要跨工单预约

工单里预先分配的号段必然撞车（18 号预留的 `…0061/0062` 已被 17 号占用）。**实施时现查现取。**

### refresh token 无服务端吊销

泄露窗口 = refresh 有效期（默认 7d）。已知缺陷，见 `../pitfalls.md` §四。

## 测试方式

- `auth.service.spec.ts` / `permission.service.spec.ts` / `user.service.spec.ts` / `guards/permissions.guard.spec.ts`
- 手工验证：`curl --noproxy '*' -X POST http://127.0.0.1:3000/auth/login -H "Content-Type: application/json" -d '{"username":"admin","password":"123456"}'`
  （响应是**扁平**结构 `{ accessToken, refreshToken, tokenType, expiresIn, userInfo }`）
- 演示账号：`admin` / `li` / `qian` / `wang`，密码均 `123456`
- RBAC 完整设计见 `knowledge-hub-backend/doc/rbac-权限模块工单.md`（已入库）
