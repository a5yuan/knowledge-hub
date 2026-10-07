---
status: historical
updated: 2026-09-16
---

# 用户模块优化工单：邮箱注册激活 + 邮箱验证码重置密码

## 一、总结

在既有 src/auth 模块（注册/登录/双 token/全局 Guard）之上，按 3 张流程图新增：

1. **邮箱注册激活**（`REQUIRE_EMAIL_VERIFICATION=true` 时）：注册写 `email_verified=0 + status=0` → 生成激活 token（Redis 24h）→ 发激活邮件（链接 `GET /auth/verify-email?token=xxx`）→ 点击激活（Redis 取并删 → 双字段置 1）→ 才能登录；未激活登录 → 403 明确提示
2. **重发激活邮件** `POST /auth/resend-activation`（图外补充，用户已确认）：按邮箱重发，防账号死锁
3. **邮箱验证码重置密码**（未登录找回场景，`@Public`）：`POST /auth/password/send-code`（6 位数字码，Redis 10 分钟）→ `POST /auth/password/reset`（验证码一次性，用后即删）

`REQUIRE_EMAIL_VERIFICATION=false`（当前默认）：注册行为与现状完全一致（立即可登录），不发激活邮件。

## 二、现状分析

- **kh_user 表已具备所需字段**（init.sql#L47-60）：`email_verified SMALLINT DEFAULT 1`、`status SMALLINT DEFAULT 1`，无需改表（代码显式写值）
- **注册现状**（user.service.ts#L42-73）：email 可选、email_verified/status 走默认 1 → 立即可登录；仅查 username 重复
- **登录现状**（auth.service.ts#L39-55）：只校验 `status!==1` → '用户已被禁用'，不校验 email_verified
- **依赖缺失**：package.json 无 mailer（@nestjs-modules/mailer + nodemailer，.env 注释钦点）、无 Redis 客户端（ioredis）
- **docker.compose.yml 无 Redis 服务**：本机 6379 已被外部容器 `agent_redis` 占用（docker ps 确认）→ 本项目 redis 需映射 **6380** 宿主端口
- **.env 已备好**（L53-70）：`REQUIRE_EMAIL_VERIFICATION=false` / `APP_PUBLIC_URL` / `MAIL_*`（QQ SMTP 占位 xx@xx.com）/ `REDIS_*`
- **项目约定**：ConfigService 读 .env、Logger 带 userId/docId、雪花 ID 字符串化、全局 Guard 生效（新 @Public 接口需显式标注）

## 三、已确认决策

| 决策点 | 结论 |
|---|---|
| 未激活状态存储 | **按图双字段**：注册写 `email_verified=0 + status=0`，激活后双 1；登录校验 email_verified=1 且 status=1 |
| 修改密码范围 | 仅未登录重置（send-code + reset，均 @Public），不加登录后改密 |
| 重发激活邮件 | 加 `POST /auth/resend-activation`（按邮箱重发，防 24h 过期/丢件死锁） |
| Redis 部署 | docker.compose.yml 新增 redis 服务，宿主端口 **6380:6379**（避开 agent_redis），.env `REDIS_PORT=6380` |
| 激活 token | `crypto.randomBytes(24).toString('hex')`，Redis key `email:activation:token:{token}` → userId，TTL 24h；激活用 GETDEL（校验+删除一步，防重放） |
| 验证码 | `crypto.randomInt(100000, 1000000)` 6 位数字，Redis key `email:reset:code:{email}`，TTL 10 分钟，重置成功 GETDEL（一次性） |
| 邮件实现 | @nestjs-modules/mailer + nodemailer（.env 注释钦点），SMTP 参数读 MAIL_*，邮件正文用内联 HTML（不引模板引擎） |
| 邮箱必填 | 仅 `REQUIRE_EMAIL_VERIFICATION=true` 时注册 email 必填（缺失 400）；false 时保持现状可选 |
| 邮箱查重 | true 分支注册时按邮箱查重 409 '邮箱已被注册'（deleted=false）；false 分支保持现状 |
| 防用户枚举 | resend-activation / send-code 对"邮箱不存在"统一返回模糊提示（200），SMTP 真实失败才 500 |
| verify-email 返回 | 浏览器直接打开，返回轻量 HTML 结果页（成功/失败两种），用 @Res().type('html') |
| 激活邮件发送失败 | 删除刚插入的用户+角色关联（避免账号永远无法激活），抛 500 '激活邮件发送失败，请稍后重试' |

## 四、实施步骤

### 1. 安装依赖

```bash
pnpm add @nestjs-modules/mailer nodemailer ioredis
pnpm add -D @types/nodemailer
```

### 2. Redis 接入

- **docker.compose.yml**：新增服务 `redis`（`image: redis:7-alpine`、`container_name: knowledge_hub_redis`、`ports: "6380:6379"`、volume `./volumes/redis:/data`、healthcheck `redis-cli ping`、`restart: always`）
- **.env**：`REDIS_PORT=6379` → `6380`
- **新建 src/auth/redis.service.ts**：ioredis 包装类（对齐 neo4j.service.ts 风格）——onModuleInit 用 REDIS_HOST/REDIS_PORT/REDIS_PASSWORD/REDIS_DB 连接（enableOfflineQueue 默认，连接失败仅记日志不阻断启动）；暴露 `get / setex / getdel / del`

### 3. 邮件服务

- **新建 src/auth/mail.service.ts**：封装 `MailerService`，两个方法：
  - `sendActivationMail(to, link)`：激活邮件（HTML 按钮链接 + 24h 有效期说明）
  - `sendResetCodeMail(to, code)`：验证码邮件（6 位码 + 10 分钟有效说明）
- **src/auth/auth.module.ts**：`MailerModule.forRootAsync` 读 MAIL_HOST/MAIL_PORT/MAIL_SECURE/MAIL_USER/MAIL_PASS/MAIL_FROM

### 4. 注册改造（src/auth/user.service.ts）

`register(dto)` 按 `REQUIRE_EMAIL_VERIFICATION`（constructor 注入，同 REVIEW_ENABLED 模式）分叉：

- **false（默认）**：现状不变（email_verified/status 走默认 1），返回 `{ userId, message: '注册成功，请登录' }`
- **true**：
  1. email 缺失 → 400 '开启邮箱验证时，邮箱必填'
  2. 查重合并：username 或 email 任一已存在（deleted=false）→ 409（'用户名已存在' / '邮箱已被注册'）
  3. 写 kh_user：`email_verified=0, status=0`（显式赋值，覆盖默认）
  4. 绑定 ROLE_USER（现状逻辑）
  5. 生成激活 token → Redis setex（24h）→ 发激活邮件（链接 `{APP_PUBLIC_URL}/auth/verify-email?token=xxx`）
  6. 邮件失败 → 删除刚插入的 kh_user + kh_user_role → 500 '激活邮件发送失败，请稍后重试'
  7. 返回 `{ userId, message: '注册成功，请查收激活邮件，完成激活后登录' }`

### 5. 新接口（src/auth/auth.controller.ts + user.service.ts）

| 接口 | @Public | 逻辑 |
|---|---|---|
| `GET /auth/verify-email?token=` | 是 | Redis getdel token → userId；查用户（deleted=false）→ `email_verified=1, status=1` → 成功 HTML 页；token 无效/过期/用户不存在 → 失败 HTML 页 |
| `POST /auth/resend-activation` | 是 | body `{email}`；查 `email_verified=0 && status=0 && deleted=false` 的账号 → 有则重生成 token 覆盖 Redis + 发邮件；无则跳过；统一返回 `{ message: '若该邮箱存在未激活账号，激活邮件已重新发送' }`（防枚举）；SMTP 失败 → 500 |
| `POST /auth/password/send-code` | 是 | body `{email}`；查已激活账号（email_verified=1）→ 有则 6 位码 setex 10 分钟 + 发邮件；统一返回 `{ message: '若该邮箱已注册，验证码已发送，10 分钟内有效' }`；SMTP 失败 → 500 |
| `POST /auth/password/reset` | 是 | body `{email, code, newPassword}`；Redis 取码比对 → 不匹配/过期 400 '验证码错误或已过期' → 匹配则 getdel（一次性）→ bcrypt 新哈希写库 → `{ message: '密码重置成功，请使用新密码登录' }` |

新增 DTO（3 个文件）：`resend-activation.dto.ts`（email）、`send-code.dto.ts`（email）、`reset-password.dto.ts`（email、code `@Matches(/^\d{6}$/)`、newPassword `@Length(6,50)`）；`verify-email` 用 `@Query()` token 字符串校验（`@Length(10,128)`）。

### 6. 登录校验改造（src/auth/auth.service.ts#L39-55）

密码校验通过后：

```ts
if (user.email_verified !== 1) {
  throw new ForbiddenException('邮箱未激活，请查收激活邮件完成激活后再登录');
}
if (user.status !== 1) {
  throw new ForbiddenException('用户已被禁用');   // 管理员禁用（未激活用户在上面被拦截）
}
```

（原来 401 '用户已被禁用' 改为 403 ForbiddenException，语义更准：凭据正确但账号状态不允许；未激活提示满足"无法登录(提示)"要求。JwtStrategy 的 getUserWithRoles 不改——未激活用户从未登录成功，无 refreshToken，status 校验已覆盖被禁用场景。）

### 7. 文档与测试

- **test/curl/payload/curl.md** 新增第 17 节"邮箱注册激活与找回密码"：
  - 17.1 `REQUIRE_EMAIL_VERIFICATION=false` 回归（注册即可登录）
  - 17.2 `true`：注册 → 登录 403 未激活 → resend 重发 → 邮箱点链接激活（HTML 页）→ 登录成功；重复邮箱 409
  - 17.3 找回密码：send-code → 错码 400 → reset → 新密码登录
  - Redis key 核对：`docker exec knowledge_hub_redis redis-cli keys 'email:*'` / `ttl`
  - 验证点表格（含"验证码一次性：reset 成功后原码重放 → 400"）
- **单元测试**：
  - 更新 src/auth/auth.service.spec.ts：登录未激活 403（密码正确）/ 禁用 403 用例
  - 新建 src/auth/user.service.spec.ts（mock repo/redis/mailer）：true 分支注册写 email_verified=0+status=0 并发激活邮件、邮箱重复 409、邮件失败清理用户、verifyEmail 用 getdel 激活、reset 验证码一次性（成功后 getdel，二次 400）

## 五、假设与说明

- **SMTP 需真实授权码**：.env 的 MAIL_USER/MAIL_PASS 为占位 `xx@xx.com`，验证真实发信需填 QQ 邮箱授权码；开发期可先用 false 开关回归现状，邮件链路失败路径（500）可先行验证
- 激活 token 无服务端状态强绑定：Redis 丢数据 = 激活链接失效（resend 兜底），可接受
- 未激活账号 `status=0` 与管理员禁用共用字段（用户已确认按图）；激活动作不回写 last_login_at 等其他字段
- `REQUIRE_EMAIL_VERIFICATION` 开关改后需重启应用（同 REVIEW_ENABLED 约定）
- 不做发送频率限制（图外，TODO 备注）

## 六、验证步骤

1. `pnpm build` 通过；`docker compose -f docker.compose.yml up -d redis` 启动 Redis（6380）
2. `REQUIRE_EMAIL_VERIFICATION=false` 回归：注册 → 立即登录成功（现状不变）
3. 改 `true` 重启：注册（带 email）→ 返回激活提示；同邮箱再注册 → 409；不带 email 注册 → 400
4. 未激活登录 → 403 '邮箱未激活…'
5. `docker exec knowledge_hub_redis redis-cli keys 'email:*'` 确认激活 token（TTL≈86400）
6. resend 接口 → 邮箱收到新激活邮件（旧 token 仍可用但幂等）；真实 SMTP 未配置时 → 500 失败路径可验证
7. 浏览器打开激活链接 → HTML 成功页；重复点击 → 失败页（token 已 GETDEL）
8. 激活后登录 → 双 token；Redis 中用户 email_verified=1、status=1
9. send-code → 邮箱收 6 位码（Redis TTL≈600）→ reset 错码 400 → 正确码成功 → 原码重放 400（一次性）→ 新密码登录成功
10. `pnpm test auth.service user.service` 全绿
