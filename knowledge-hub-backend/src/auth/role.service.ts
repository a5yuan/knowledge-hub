import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Not, Repository } from 'typeorm';
import SnowflakeId from 'snowflake-id';
import { KhRole } from './entities/kh-role.entity';
import { KhRolePermission } from './entities/kh-role-permission.entity';
import { KhUserRole } from './entities/kh-user-role.entity';
import { KhPermission } from './entities/kh-permission.entity';
import { PERMISSION_TYPE } from './permission.service';
import type {
  AssignRolePermissionsDto,
  CreateRoleDto,
  UpdateRoleDto,
} from './dto/role.dto';

/** 内置角色编码（init.sql 预置），不可删除 */
const BUILTIN_ROLE_CODES = ['ROLE_ADMIN', 'ROLE_REVIEWER', 'ROLE_USER'];

/** 权限树节点（GET /role/permission-tree 返回元素） */
export interface PermissionTreeNode {
  id: string;
  permissionName: string;
  permissionCode: string;
  permissionType: number;
  children: PermissionTreeNode[];
}

/** 角色视图（接口返回 camelCase，与前端类型对齐） */
export interface RoleView {
  id: string;
  roleName: string;
  roleCode: string;
  description: string | null;
  status: number;
}

/**
 * 角色服务（权限模型控制工单）：
 * 角色管理 + 全量权限树 + 角色授权保存。
 * 接口权限本期不做：权限树不下发 permission_type=3 节点，接口也不加 @RequirePermission。
 */
@Injectable()
export class RoleService {
  /** 应用侧雪花ID生成器（用法同 user.service） */
  private readonly snowflake = new SnowflakeId();

  constructor(
    @InjectRepository(KhRole)
    private readonly roleRepo: Repository<KhRole>,
    @InjectRepository(KhRolePermission)
    private readonly rolePermRepo: Repository<KhRolePermission>,
    @InjectRepository(KhPermission)
    private readonly permRepo: Repository<KhPermission>,
  ) { }

  /** 角色分页列表（按 id 升序，预置角色在前） */
  async findRoles(page = 1, pageSize = 10): Promise<{ total: number; list: RoleView[] }> {
    const [roles, total] = await this.roleRepo.findAndCount({
      order: { id: 'ASC' },
      skip: (page - 1) * pageSize,
      take: pageSize,
    });
    return { total, list: roles.map((r) => this.toView(r)) };
  }

  /** 新建角色：雪花ID + 自动生成唯一 role_code（ROLE_ + 雪花值） */
  async createRole(dto: CreateRoleDto): Promise<RoleView> {
    const id = this.snowflake.generate();
    const role = await this.roleRepo.save(
      this.roleRepo.create({
        id,
        role_name: dto.roleName,
        role_code: `ROLE_${id}`,
        description: dto.description ?? null,
        status: 1,
      }),
    );
    return this.toView(role);
  }

  /** 编辑角色（名称/描述/状态） */
  async updateRole(id: string, dto: UpdateRoleDto): Promise<RoleView> {
    const role = await this.roleRepo.findOne({ where: { id } });
    if (!role) throw new NotFoundException('角色不存在');
    if (dto.roleName !== undefined) role.role_name = dto.roleName;
    if (dto.description !== undefined) role.description = dto.description;
    if (dto.status !== undefined) role.status = dto.status;
    await this.roleRepo.save(role);
    return this.toView(role);
  }

  /**
   * 删除角色（内置角色保护）：事务内级联清理角色权限关联与用户角色绑定，再删角色本身
   * （kh_user_role/kh_role_permission 外键引用 kh_role，不清理会触发 FK 约束错误）
   */
  async deleteRole(id: string): Promise<{ id: string }> {
    const role = await this.roleRepo.findOne({ where: { id } });
    if (!role) throw new NotFoundException('角色不存在');
    if (BUILTIN_ROLE_CODES.includes(role.role_code)) {
      throw new BadRequestException('内置角色不可删除');
    }
    await this.roleRepo.manager.transaction(async (em) => {
      await em.delete(KhRolePermission, { role_id: id });
      await em.delete(KhUserRole, { role_id: id });
      await em.delete(KhRole, { id });
    });
    return { id };
  }

  /**
   * 全量权限树（角色授权弹窗数据源）：
   * 仅启用且未删除的 菜单/按钮 节点（permission_type != 3，接口权限本期不做），同级按 sort 升序
   */
  async getPermissionTree(): Promise<PermissionTreeNode[]> {
    const rows = await this.permRepo.find({
      where: { status: 1, deleted: false, permission_type: Not(PERMISSION_TYPE.API) },
      order: { sort: 'ASC' },
    });
    const nodeMap = new Map<string, PermissionTreeNode>(
      rows.map((m) => [
        m.id,
        {
          id: m.id,
          permissionName: m.permission_name,
          permissionCode: m.permission_code,
          permissionType: m.permission_type,
          children: [],
        },
      ]),
    );
    const roots: PermissionTreeNode[] = [];
    for (const m of rows) {
      const node = nodeMap.get(m.id)!;
      const parent = nodeMap.get(m.parent_id);
      if (parent) {
        parent.children.push(node);
      } else {
        roots.push(node);
      }
    }
    return roots;
  }

  /** 角色已授权限ID列表（弹窗回显） */
  async getRolePermissionIds(roleId: string): Promise<string[]> {
    await this.assertRole(roleId);
    const links = await this.rolePermRepo.find({ where: { role_id: roleId } });
    return links.map((l) => l.permission_id);
  }

  /**
   * 保存角色权限（全量覆盖）：校验权限ID有效性 → 事务内删旧关联 + 批量插入新关联
   * 传空数组即清空该角色全部权限
   */
  async assignRolePermissions(
    roleId: string,
    dto: AssignRolePermissionsDto,
  ): Promise<{ roleId: string; count: number }> {
    await this.assertRole(roleId);
    const ids = [...new Set(dto.permissionIds)];
    if (ids.length > 0) {
      const found = await this.permRepo.find({ where: { id: In(ids) }, select: { id: true } });
      const foundSet = new Set(found.map((p) => p.id));
      const invalid = ids.filter((x) => !foundSet.has(x));
      if (invalid.length > 0) {
        throw new BadRequestException(`无效权限ID：${invalid.join(',')}`);
      }
    }
    await this.roleRepo.manager.transaction(async (em) => {
      await em.delete(KhRolePermission, { role_id: roleId });
      if (ids.length > 0) {
        await em.insert(
          KhRolePermission,
          ids.map((permission_id) => ({
            id: this.snowflake.generate(),
            role_id: roleId,
            permission_id,
          })),
        );
      }
    });
    return { roleId, count: ids.length };
  }

  /** 角色存在性校验（弹窗回显/保存前置） */
  private async assertRole(roleId: string): Promise<KhRole> {
    const role = await this.roleRepo.findOne({ where: { id: roleId } });
    if (!role) throw new NotFoundException('角色不存在');
    return role;
  }

  private toView(r: KhRole): RoleView {
    return {
      id: r.id,
      roleName: r.role_name,
      roleCode: r.role_code,
      description: r.description,
      status: r.status,
    };
  }
}
