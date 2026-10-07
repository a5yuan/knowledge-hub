import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { KhPermission } from './entities/kh-permission.entity';
import { KhRolePermission } from './entities/kh-role-permission.entity';
import { KhUserPermission } from './entities/kh-user-permission.entity';
import { KhUserRole } from './entities/kh-user-role.entity';

/** 权限类型（kh_permission.permission_type，对应 init.sql 注释与图3 三级权限） */
export const PERMISSION_TYPE = { MENU: 1, BUTTON: 2, API: 3 } as const;
/** 超管角色编码：拥有所有权限，绕过权限码校验（图4 Admin 直接放行） */
export const ADMIN_ROLE_CODE = 'ROLE_ADMIN';

/** 菜单节点（GET /auth/permissions 返回的菜单树元素，前端按 menuUrl/icon 渲染） */
export interface MenuNode {
  id: string;
  permissionName: string;
  permissionCode: string;
  menuUrl: string | null;
  icon: string | null;
  sort: number;
  children: MenuNode[];
}

/** 当前用户三级权限总览（图3：菜单级 + 按钮级 + 全量权限码） */
export interface PermissionOverview {
  /** 全量权限码（角色权限 ∪ 直赋权限，含菜单/按钮/接口各类型） */
  codes: string[];
  /** 菜单树（type=1，含祖先链，前端渲染可见菜单） */
  menus: MenuNode[];
  /** 按钮级权限码（type=2，前端控制按钮显隐） */
  buttons: string[];
}

/**
 * 权限服务（RBAC 运行时，图1/图2 数据模型 + 图3 三级权限）：
 * 用户最终权限 = 角色权限 ∪ 用户直赋权限（去重合并），仅统计启用(status=1)且未删除的权限
 * 不做缓存：每次实时查询，与 JwtStrategy「每请求实时重查角色」同一哲学，权限变更即时生效
 */
@Injectable()
export class PermissionService {
  constructor(
    @InjectRepository(KhUserRole)
    private readonly userRoleRepo: Repository<KhUserRole>,
    @InjectRepository(KhRolePermission)
    private readonly rolePermRepo: Repository<KhRolePermission>,
    @InjectRepository(KhUserPermission)
    private readonly userPermRepo: Repository<KhUserPermission>,
    @InjectRepository(KhPermission)
    private readonly permRepo: Repository<KhPermission>,
  ) {}

  /** 用户权限码列表（PermissionsGuard 校验数据源）：角色权限 ∪ 直赋权限，去重 */
  async getUserPermissionCodes(userId: string): Promise<string[]> {
    const perms = await this.getUserPermissions(userId);
    return perms.map((p) => p.permission_code);
  }

  /**
   * 三级权限总览（GET /auth/permissions 数据源，图3）：
   * codes 全量码 / menus 菜单树（含祖先链）/ buttons 按钮码
   */
  async getPermissionOverview(userId: string): Promise<PermissionOverview> {
    const perms = await this.getUserPermissions(userId);
    const codes = perms.map((p) => p.permission_code);
    const buttons = perms
      .filter((p) => p.permission_type === PERMISSION_TYPE.BUTTON)
      .map((p) => p.permission_code);
    const menus = await this.buildMenuTree(perms);
    return { codes, menus, buttons };
  }

  /** 用户生效权限实体列表：4 次查询（用户角色 → 角色权限 ∪ 直赋权限 → 权限明细过滤） */
  private async getUserPermissions(userId: string): Promise<KhPermission[]> {
    const roleLinks = await this.userRoleRepo.find({ where: { user_id: userId } });
    const rolePermLinks = roleLinks.length
      ? await this.rolePermRepo.find({
          where: { role_id: In(roleLinks.map((l) => l.role_id)) },
        })
      : [];
    const userPermLinks = await this.userPermRepo.find({
      where: { user_id: userId },
    });
    // 并集去重（Set）：角色权限 ∪ 直赋权限
    const permIds = [
      ...new Set([
        ...rolePermLinks.map((l) => l.permission_id),
        ...userPermLinks.map((l) => l.permission_id),
      ]),
    ];
    if (permIds.length === 0) return [];
    return this.permRepo.find({
      where: { id: In(permIds), status: 1, deleted: false },
      order: { sort: 'ASC' },
    });
  }

  /**
   * 组菜单树：用户命中的 type=1 菜单 + 沿 parent_id 补全祖先链（子菜单可见则父菜单必现，防悬挂）
   * 根节点 parent_id = '0'；同级按 sort 升序（查询已排序）
   */
  private async buildMenuTree(userPerms: KhPermission[]): Promise<MenuNode[]> {
    const userMenus = userPerms.filter(
      (p) => p.permission_type === PERMISSION_TYPE.MENU,
    );
    if (userMenus.length === 0) return [];

    const allMenus = await this.permRepo.find({
      where: { permission_type: PERMISSION_TYPE.MENU, status: 1, deleted: false },
      order: { sort: 'ASC' },
    });
    const byId = new Map(allMenus.map((m) => [m.id, m]));
    const keep = new Set(userMenus.map((m) => m.id));
    for (const m of userMenus) {
      let cur = byId.get(m.id);
      while (cur && cur.parent_id !== '0') {
        keep.add(cur.parent_id);
        cur = byId.get(cur.parent_id);
      }
    }
    const nodes = allMenus.filter((m) => keep.has(m.id));

    const nodeMap = new Map<string, MenuNode>(
      nodes.map((m) => [
        m.id,
        {
          id: m.id,
          permissionName: m.permission_name,
          permissionCode: m.permission_code,
          menuUrl: m.menu_url,
          icon: m.icon,
          sort: m.sort,
          children: [],
        },
      ]),
    );
    const roots: MenuNode[] = [];
    for (const m of nodes) {
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
}
