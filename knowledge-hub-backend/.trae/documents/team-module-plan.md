---
status: historical
updated: 2026-09-17
---

# 团队模块工单 — 实施计划

## 概要

基于 init.sql#L187-223 已有的 kh_team / kh_team_member 两表与种子（技术中心/后端开发组），新建 `src/team` 模块：补齐实体、DTO、团队 CRUD 与成员管理（增删查改），并接入 RBAC 权限体系（补 team:* 权限码种子 + @RequirePermission 标注）。模式完全对齐 document/auth 模块既有约定。

用户已确认：含成员管理；补种子+标注权限。

## 现状分析（已探明）

| 项 | 现状 |
|---|---|
| 数据库 | kh_team（含 leader_id/parent_id 树形/sort/status/软删）+ kh_team_member（UNIQUE(team_id,user_id)，member_role leader/member）已建表；种子 2 团队 + 3 成员行；上次已随 init.sql 应用到运行容器 |
| src/team | 不存在，从零创建 |
| CRUD 模板 | [document.service.ts](file:///d:/桌面/AI项目/企业级知识库/knowledge-hub-backend/src/document/document.service.ts)：雪花ID `new SnowflakeId().generate()`、软删 `deleted:false` where、分页 `{items,total,page,pageSize}`、`normalizeSnowflakeId` 归一化、23505/23503 错误码兜底 |
| 实体规范 | bigint 主键 + normalizeSnowflakeId transformer（kh-user-role/kh-permission 同款） |
| 鉴权 | 全局三 Guard 已就位；`@CurrentUser()` 可取 AuthUser；权限码复用 type=2 行（UNIQUE 一码一行） |
| 权限种子 | 已有 system:team 菜单码（4000000000000000024，parent=system），**无 team:* 按钮码** |

## 接口设计（/team，遵循现有单数前缀约定）

| 方法 | 路径 | 权限标注 | 说明 |
|---|---|---|---|
| POST | /team | @RequirePermission('team:create') | 创建团队；leader_id 缺省取当前登录用户 |
| GET | /team | —（登录即可） | 分页：team_name 模糊 / team_code / status |
| GET | /team/:id | —（登录即可） | 详情，404 兜底 |
| PATCH | /team/:id | @RequirePermission('team:edit') | 更新（含 status 启停） |
| DELETE | /team/:id | @RequirePermission('team:delete') | 软删（成员关联行不动，列表以 deleted=false 为准） |
| POST | /team/:id/members | @RequirePermission('team:member') | 添加成员（重复 → 409） |
| GET | /team/:id/members | —（登录即可） | 成员列表（联 kh_user 返回 username/real_name） |
| PATCH | /team/:id/members/:userId | @RequirePermission('team:member') | 切换 leader/member |
| DELETE | /team/:id/members/:userId | @RequirePermission('team:member') | 移除成员（关联行硬删，表无 deleted 列） |

权限种子矩阵（演示区分度）：ROLE_USER 得 team:create/edit/member；**team:delete 不授权任何角色**（仅 Admin 旁路可删）；ROLE_REVIEWER 无 team 权限（create 403 对照）。

## 变更清单

### 新增（10 个文件）

**1-2. 实体** `src/team/entities/kh-team.entity.ts` / `kh-team-member.entity.ts`
- KhTeam：id（bigint+transformer）、team_name、team_code、description、leader_id（bigint）、parent_id（bigint，默认'0'）、sort、status、created_at/updated_at（Create/UpdateDateColumn）、deleted
- KhTeamMember：id（transformer）、team_id、user_id（bigint）、member_role（varchar，默认'member'）、created_at（CreateDateColumn）

**3-6. DTO** `src/team/dto/`
- create-team.dto.ts：team_name @IsString 必填；team_code/description/leader_id/parent_id 可选 @IsString；sort @IsOptional @Type(()=>Number) @IsInt @Min(0)
- update-team.dto.ts：`extends PartialType(CreateTeamDto)` + status @IsOptional @IsInt @IsIn([0,1])
- query-team.dto.ts：team_name（Like）/ team_code / status / page=1 / pageSize=20（@Type 转换，对齐 QueryDocumentDto）
- team-member.dto.ts：AddTeamMemberDto（user_id 必填、member_role @IsOptional @IsIn(['leader','member'])）；UpdateMemberRoleDto（member_role @IsIn(['leader','member']) 必填）

**7. team.service.ts**
- `create(dto, user)`：snowflake 生成 id；`leader_id = dto.leader_id ?? user.userId`（建团人默认负责人）；23503 FK 兜底 → 400「负责人或父团队不存在」
- `findAll(query)`：where deleted=false + team_name Like + 可选等值；findAndCount 分页 `{items,total,page,pageSize}`
- `findOne(id)`：normalizeSnowflakeId → 404
- `update(id, dto)`：404 → save
- `remove(id)`：404 → 软删（deleted=true）
- `addMember(teamId, dto)`：校验团队存在未删（404）；UNIQUE 兜底 23505 → 409「成员已存在」
- `listMembers(teamId)`：teamMemberRepo.find({team_id}) → KhUser repo `In(userIds)` 组装 {userId, username, realName, memberRole, joinedAt}
- `updateMemberRole(teamId, userId, role)`：find → 404 → save
- `removeMember(teamId, userId)`：find → 404 → delete（硬删）
- 日志带 teamId/memberId 可追溯（项目约定）

**8. team.controller.ts**：上表 9 端点；create 注入 `@CurrentUser()`；异常文案中文对齐 document 模块

**9. team.module.ts**：TypeOrmModule.forFeature([KhTeam, KhTeamMember, KhUser])（KhUser 供成员列表联查）

**10. 单测** `src/team/team.service.spec.ts`（mock repo，风格对齐 permission.service.spec）
1. create：leader_id 缺省取当前登录用户
2. create：leader 不存在（23503）→ 400
3. addMember：重复成员（23505）→ 409
4. removeMember：成员不存在 → 404
5. remove：软删后 findAll 不再出现（where deleted=false）
6. updateMemberRole：leader→member 生效；不存在 → 404

### 修改（3 个文件）

**11. init-scripts/postgresql/init.sql** — 团队段后追加幂等块：
```sql
-- 团队管理权限码（parent = system:team 菜单）
INSERT INTO kh_permission (id, parent_id, permission_name, permission_code, permission_type, sort) VALUES
    (4000000000000000051, 4000000000000000024, '创建团队', 'team:create', 2, 1),
    (4000000000000000052, 4000000000000000024, '编辑团队', 'team:edit', 2, 2),
    (4000000000000000053, 4000000000000000024, '删除团队', 'team:delete', 2, 3),
    (4000000000000000054, 4000000000000000024, '成员管理', 'team:member', 2, 4)
ON CONFLICT (id) DO NOTHING;
-- ROLE_USER 授权 create/edit/member；team:delete 不授权（仅 Admin 旁路，演示权限收敛）
INSERT INTO kh_role_permission (id, role_id, permission_id) VALUES
    (4100000000000000012, 2000000000000000003, 4000000000000000051),
    (4100000000000000013, 2000000000000000003, 4000000000000000052),
    (4100000000000000014, 2000000000000000003, 4000000000000000054)
ON CONFLICT (id) DO NOTHING;
```

**12. src/app.module.ts** — imports 增 TeamModule

**13. test/curl/payload/curl.md** — 追加「19. 团队模块（CRUD + 成员管理 + 权限接入）」：admin 全通过；user create=201、delete=403（team:delete 无授权行）；reviewer create=403；成员增删改查链路；种子应用命令（docker cp + psql）

**14. doc/团队模块工单.md** — 工单落盘（与 RBAC 工单同风格）：mermaid ER 图、接口-权限对照表、代码摘录、验证矩阵、后续迭代（leader 权限语义、我的团队接口、kh_document.team_id 联动）

## 假设与决策

- 路径前缀 `/team`（document 用单数 /document，一致性优先；菜单 URL /admin/teams 是前端路由不冲突）
- 团队名不唯一（init.sql 无约束）→ 不做查重
- 不实现「leader 才能改/删自己团队」的数据权限（本期 RBAC 码级控制，leader 语义仅存 member_role 字段；列为后续迭代）
- 移除成员/切换角色不校验最后一个 leader（最小实现，工单标注后续约束）
- KhUser 实体跨模块复用 forFeature 注册（autoLoadEntities，无循环依赖：TeamModule 不 import AuthModule）
- 种子应用：kh_team 表上次已建，本次增量仅权限码 + 授权行（docker cp + psql -f 幂等）

## 验证步骤

1. `pnpm build`；`pnpm test src/team`（6 例）+ 既有 auth 测试不回归
2. docker cp init.sql → psql -f 应用种子增量；核对 team:* 权限码 4 行
3. 运行时 curl 矩阵（第 19 节）：admin 全通过（旁路）；user create=201 / delete=403「team:delete」；reviewer create=403；user 建团（leader 缺省=自己）→ 加 user 为成员 → 切角色 → 移除 → 全链路
4. 测试数据清理（删除 curl 建的团队），停止验证用服务
