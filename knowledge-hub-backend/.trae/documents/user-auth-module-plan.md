---
status: historical
updated: 2026-09-16
---

# 用户模块工单：注册 / 登录 / 双 Token 鉴权 + 全局 Guard

## 一、总结

按 3 张流程图实现完整鉴权体系：

1. **注册** `POST /auth/register`：查重 → 雪花 ID → bcrypt(cost=10) → 写 kh_user → 绑定 ROLE_USER
2. **登录** `POST /auth/login`：校验密码 → 更新 lastLoginAt → 签发双 JWT（access 2h / refresh 7d）
3. **鉴权接口**：`POST /auth/refresh`（轮换双 token）、`GET /auth/me`、`GET /auth/reviewer-ids`（审批员列表）
4. **全局 Guard**：passport 标准模式（JwtStrategy）+ JwtAuthGuard（@Public 跳过）+ RolesGuard（@Roles 校验），**全局生效**——document/search 所有接口必须携带 accessToken
5. **审核人注入**：approve/reject 的 reviewer_id/reviewer_name 从 token 自动注入（@CurrentUser），不再信任请求体

## 二、现状分析

- **无任何鉴权设施**：package.json 无 JWT/bcrypt/passport 依赖；src 下无 user/auth 模块、无 Guard
- **数据表已就绪**（init-scripts/postgresql/init.sql#L45-100）：kh_user / kh_role / kh_user_role，预置 3 角色 + 3 测试账号（admin/reviewer/user，密码 123456，bcrypt cost=10）+ 角色关联
- **现有约定**：
  - 雪花 ID 字符串化：`new SnowflakeId().generate()` 生成，entity 主键用 transformer + `normalizeSnowflakeId`（见 document.entity.ts#L14-20）
  - DTO 用 class-validator；service 用 NestJS Logger；错误统一 BadRequestException/NotFoundException 等内置异常
  - 配置经 ConfigService 读 .env；TypeORM `synchronize: false`，表结构由 init.sql 管理（无需改表）
- **受影响面**：
  - 全局 Guard 生效后 document/search 全部接口需 token（用户已确认）
  - review-action.dto.ts 注释"项目无鉴权体系，审核人身份由请求体透传"将失效（用户已确认改为 token 注入）

## 三、已确认决策

| 决策点 | 结论 |
|---|---|
| 全局 Guard 生效范围 | 仅 /auth/register、/auth/login、/auth/refresh、AppController 根路由标 @Public；document/search 需 token |
| JWT 实现 | @nestjs/passport + passport + passport-jwt（JwtStrategy 标准模式）+ bcryptjs |
| 审核人身份 | approve/reject 从 token 注入，ReviewActionDto 删除 reviewer_id/reviewer_name |
| JWT 算法 | HS256（单密钥，.env JWT_SECRET）；payload `{ sub, username, type }` 与流程图一致 |
| Token 有效期 | access 2h（expiresIn 7200）、refresh 7d，均入 .env 可配 |
| refresh 语义 | 校验 type='refresh' → 按 sub 重查用户（含角色，校验 status/deleted）→ **轮换签发新双 token** + userInfo |
| roles 获取 | JwtStrategy.validate 每次请求按 sub 重查用户（新鲜角色 + 天然拦截禁用/删除用户），挂载到 request.user |
| @Roles 本期落点 | approve/reject 加 `@Roles('ROLE_REVIEWER', 'ROLE_ADMIN')`（测试账号 admin/reviewer 均有此角色，不影响现有测试流） |

## 四、实施步骤

### 1. 安装依赖

```bash
pnpm add @nestjs/jwt @nestjs/passport passport passport-jwt bcryptjs
pnpm add -D @types/passport-jwt
```

（bcryptjs 纯 JS，Windows 免编译；可校验 init.sql 预置的 `$2a$10$` 哈希）

### 2. .env 追加

```
# ---- JWT 鉴权 ----
JWT_SECRET=kh-jwt-secret-<随机串>
JWT_ACCESS_EXPIRES=2h
JWT_REFRESH_EXPIRES=7d
```

### 3. 新建 src/auth 模块（17 个新文件）

```
src/auth/
  entities/kh-user.entity.ts        # kh_user 映射：id bigint+transformer、status、last_login_at、deleted
  entities/kh-role.entity.ts        # kh_role 映射：role_code 唯一
  entities/kh-user-role.entity.ts   # kh_user_role 映射
  interfaces/auth-user.interface.ts # request.user 形状：{ userId, username, realName, email, avatar, roles: string[] }
  dto/register.dto.ts               # username 必填、password @Length(6,50)、email 可选 @IsEmail、realName 可选
  dto/login.dto.ts                  # username、password 必填
  dto/refresh-token.dto.ts          # refreshToken 必填
  strategies/jwt.strategy.ts        # passport-jwt：Bearer 提取 → 验签 → 校验 payload.type==='access' → 按 sub 重查用户 → 挂 request.user
  guards/jwt-auth.guard.ts          # AuthGuard('jwt') + @Public 反射跳过；401 默认行为
  guards/roles.guard.ts             # @Roles 反射；无 @Roles 放行；无交集 403
  decorators/public.decorator.ts    # SetMetadata(IS_PUBLIC_KEY, true)
  decorators/roles.decorator.ts     # SetMetadata(ROLES_KEY, roles)
  decorators/current-user.decorator.ts # createParamDecorator 取 request.user
  user.service.ts                   # register、findByUsername、getUserWithRoles（联查角色）、findReviewers、updateLastLogin
  auth.service.ts                   # login、refresh、签发双 token（同一 payload，type 区分）
  auth.controller.ts                # 5 个接口
  auth.module.ts                    # PassportModule + JwtModule.registerAsync + forFeature(3 实体)；APP_GUARD 注册两 Guard（JwtAuthGuard 在前）；exports UserService
```

关键实现点：

- **register**（对齐注册流程图）：
  - 查 `username AND deleted=false` 已存在 → `ConflictException('用户名已存在')`；并发兜底：捕获 23505 唯一索引冲突同样返回 409
  - 雪花 ID（同 DocumentService 写法）+ `bcrypt.hash(password, 10)`
  - 绑定默认角色：按 role_code='ROLE_USER' 查 kh_role → 插 kh_user_role（雪花 ID）
  - 返回 `{ userId, message: '注册成功，请登录' }`（不自动登录）
- **login**（对齐登录流程图）：
  - 查用户（deleted=false）不存在或 `bcrypt.compare` 失败 → 统一 `UnauthorizedException('用户名或密码错误')`（防用户枚举）
  - status!==1 → `UnauthorizedException('用户已被禁用')`
  - 联查角色 → 更新 last_login_at → 签发 `{ sub: userId, username, type: 'access'|'refresh' }` 双 token
  - 返回 `{ accessToken, refreshToken, tokenType: 'Bearer', expiresIn: 7200, userInfo: { userId, username, realName, email, avatar, roles } }`
- **refresh**（@Public）：`jwtService.verify` 捕获异常 → 401 'refreshToken 无效或已过期'；`type!=='refresh'` → 401；按 sub 重查用户（禁用/删除 → 401）→ 轮换签发新双 token，返回结构同 login
- **me**（需登录）：直接返回 request.user（strategy 已重查 DB，信息新鲜）
- **reviewer-ids**（需登录）：kh_user_role JOIN kh_role（role_code='ROLE_REVIEWER'）JOIN kh_user（status=1, deleted=false）→ 返回 `[{ userId, username, realName }]`（前端选审核人 + 回显姓名）
- **JwtStrategy.validate**：`type!=='access'` 时拒绝 → 落实"refresh_token 不能调用业务 API"（401）
- **refresh token 签发**：`jwtService.sign(payload, { expiresIn: config.JWT_REFRESH_EXPIRES })` 单点覆盖默认 2h

### 4. 接入全局（修改 2 个文件）

- **src/app.module.ts**：imports 增加 `AuthModule`（APP_GUARD 随模块注册即全局生效）
- **src/app.controller.ts**：根路由加 `@Public()`（健康检查保留公开）

### 5. document 模块改造（修改 3 个文件）

- **document.controller.ts**：approve/reject 增加 `@CurrentUser() user: AuthUser` 参数并传入 service；approve/reject 加 `@Roles('ROLE_REVIEWER', 'ROLE_ADMIN')`
- **document.service.ts**：`approve(id, dto, user)` / `reject(id, dto, user)` / `settleReview(..., user)`：`pending.reviewer_id = user?.userId ?? null`、`pending.reviewer_name = user?.realName ?? null`
- **dto/review-action.dto.ts**：删除 reviewer_id / reviewer_name，仅保留 comment；更新过时注释

### 6. 测试与文档更新（修改 1 个文件）

- **test/curl/payload/curl.md**：
  - 新增"第 15 节：用户模块"——register/login/refresh/me/reviewer-ids 的 curl + 预期响应（测试账号 admin/reviewer/user，密码 123456）
  - 既有各节 curl 统一补 `Authorization: Bearer <accessToken>`；approve/reject 请求体仅剩 comment；补充 401（无 token）/403（user 账号审核）验证点

### 7. 单元测试（新建 1 个文件，沿用 mq.service.spec.ts 先例）

- **src/auth/auth.service.spec.ts**：登录成功返回双 token 结构 / 密码错误 401（统一文案）/ refresh 传 accessToken 类型拒绝 / refresh 用户被禁用 401。用 mock Repository + bcryptjs 真实比对预置哈希

## 五、假设与说明

- 表结构零改动：init.sql 已建好 kh_user/kh_role/kh_user_role，TypeORM synchronize=false 不受影响
- 无服务端 token 吊销/黑名单（无状态 JWT）；token 泄露窗口 = 有效期，本期不涉及（后续可加 Redis 黑名单）
- 用户角色变更在下次换发 token 后生效（strategy 实时查 DB，仅 username 取自 token）
- search 接口也需登录（全局生效决策的直接后果，ES 检索逻辑不动）

## 六、验证步骤

1. `pnpm build` 通过
2. `pnpm start:dev` 启动（依赖 docker 服务运行中）
3. 无 token `GET /document` → 401；带 token → 200
4. `POST /auth/register` 新用户 → 返回 userId + 提示语；重复用户名 → 409；密码 <6 位 → 400
5. `POST /auth/login`（admin/123456）→ 双 token + userInfo.roles 含 ROLE_ADMIN；错误密码 → 401 '用户名或密码错误'
6. `GET /auth/me` 带 accessToken → 用户信息；带 refreshToken → 401（type 校验）
7. `POST /auth/refresh` → 新双 token 轮换；伪造/过期 token → 401
8. `GET /auth/reviewer-ids` → 返回 reviewer 张三（id=...0002）
9. `POST /document/:id/approve`：reviewer token + REVIEW_ENABLED=true → 成功且审核记录 reviewer_id=token 注入；user 账号 token → 403
10. access token 过期（可临时把 JWT_ACCESS_EXPIRES=5s）→ 业务接口 401 → refresh 换新后恢复
