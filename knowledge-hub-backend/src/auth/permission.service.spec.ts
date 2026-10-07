import { In } from 'typeorm';
import { PermissionService } from './permission.service';
import type { KhPermission } from './entities/kh-permission.entity';

/**
 * 权限服务语义测试：为什么重要——
 * 1) 用户最终权限必须 = 角色权限 ∪ 直赋权限且去重（图1/图2 的核心合并语义）：
 *    直赋是角色权限的补充通道，重复授权不能放大权限，漏合并会让直赋形同虚设；
 * 2) 禁用(status=0)/软删(deleted=true)的权限绝不能生效（管理员下架权限必须即时收敛）；
 * 3) 无角色无直赋的用户权限必须为空数组（默认最小权限）；
 * 4) 菜单树必须补全祖先链：子菜单可见而父菜单未直接授权时，父菜单仍要出现在树里（防菜单悬挂）。
 * 任何人破坏合并去重、放行禁用权限、丢祖先节点，测试必须变红。
 */

const makePerm = (overrides: Partial<KhPermission>): KhPermission =>
    ({
        parent_id: '0',
        permission_name: '',
        permission_code: '',
        permission_type: 2,
        menu_url: null,
        api_url: null,
        method: null,
        icon: null,
        sort: 0,
        status: 1,
        deleted: false,
        ...overrides,
    }) as KhPermission;

const ID = {
    ROLE_REVIEWER: '2000000000000000002',
    P_LIST: '4000000000000000011',
    P_REVIEW: '4000000000000000015',
    P_CREATE: '4000000000000000012',
    M_DASH: '4000000000000000001',
    M_DOC: '4000000000000000002',
    M_SYS: '4000000000000000005',
    M_USER: '4000000000000000021',
};

describe('PermissionService 权限合并与菜单树语义', () => {
    let svc: PermissionService;
    let userRoleRepo: { find: jest.Mock };
    let rolePermRepo: { find: jest.Mock };
    let userPermRepo: { find: jest.Mock };
    let permRepo: { find: jest.Mock };

    beforeEach(() => {
        jest.clearAllMocks();
        userRoleRepo = { find: jest.fn().mockResolvedValue([]) };
        rolePermRepo = { find: jest.fn().mockResolvedValue([]) };
        userPermRepo = { find: jest.fn().mockResolvedValue([]) };
        permRepo = { find: jest.fn().mockResolvedValue([]) };
        svc = new PermissionService(
            userRoleRepo as never,
            rolePermRepo as never,
            userPermRepo as never,
            permRepo as never,
        );
    });

    describe('getUserPermissionCodes（角色权限 ∪ 直赋权限）', () => {
        it('并集去重：角色权限 + 直赋权限合并，同一权限双通道授权不重复', async () => {
            // reviewer：角色给 list + review，直赋 create + review（review 重复）
            userRoleRepo.find.mockResolvedValue([{ role_id: ID.ROLE_REVIEWER }]);
            rolePermRepo.find.mockResolvedValue([
                { permission_id: ID.P_LIST },
                { permission_id: ID.P_REVIEW },
            ]);
            userPermRepo.find.mockResolvedValue([
                { permission_id: ID.P_CREATE },
                { permission_id: ID.P_REVIEW },
            ]);
            permRepo.find.mockResolvedValue([
                makePerm({ id: ID.P_LIST, permission_code: 'document:list' }),
                makePerm({ id: ID.P_REVIEW, permission_code: 'document:review' }),
                makePerm({ id: ID.P_CREATE, permission_code: 'document:create' }),
            ]);

            const codes = await svc.getUserPermissionCodes('1000000000000000002');

            expect(codes).toEqual(
                expect.arrayContaining(['document:list', 'document:review', 'document:create']),
            );
            expect(codes).toHaveLength(3);
            // 去重生效：4 条关联（2 角色 + 2 直赋，review 重复）只产生 3 个去重后的 permission_id
            const where = permRepo.find.mock.calls[0][0].where;
            expect(where.id.value).toHaveLength(3);
            expect(where.status).toBe(1);
            expect(where.deleted).toBe(false);
        });

        it('禁用/软删权限被 where(status=1, deleted=false) 过滤，永不生效', async () => {
            userRoleRepo.find.mockResolvedValue([{ role_id: ID.ROLE_REVIEWER }]);
            rolePermRepo.find.mockResolvedValue([{ permission_id: ID.P_REVIEW }]);
            userPermRepo.find.mockResolvedValue([]);
            // 管理员已禁用该权限：查询条件必须排除，返回空
            permRepo.find.mockResolvedValue([]);

            const codes = await svc.getUserPermissionCodes('1000000000000000002');

            expect(codes).toEqual([]);
            expect(permRepo.find).toHaveBeenCalledWith(
                expect.objectContaining({
                    where: expect.objectContaining({ status: 1, deleted: false }),
                }),
            );
        });

        it('无角色无直赋 → 空数组（默认最小权限），且不触发权限明细查询', async () => {
            userRoleRepo.find.mockResolvedValue([]);
            userPermRepo.find.mockResolvedValue([]);

            const codes = await svc.getUserPermissionCodes('1000000000000000003');

            expect(codes).toEqual([]);
            expect(permRepo.find).not.toHaveBeenCalled();
        });
    });

    describe('getPermissionOverview（三级权限总览）', () => {
        it('menus 含祖先链 + buttons 仅 type=2：子菜单可见则父菜单必现（防悬挂）', async () => {
            // 用户角色仅命中 子菜单 system:user + 按钮级 document:create，未直接拥有父菜单 system
            userRoleRepo.find.mockResolvedValue([{ role_id: ID.ROLE_REVIEWER }]);
            rolePermRepo.find.mockResolvedValue([
                { permission_id: ID.M_USER },
                { permission_id: ID.P_CREATE },
            ]);
            userPermRepo.find.mockResolvedValue([]);
            permRepo.find.mockImplementation(({ where }: { where: Record<string, unknown> }) => {
                if ('id' in where) {
                    // 第一次查询：用户权限明细
                    return Promise.resolve([
                        makePerm({
                            id: ID.M_USER,
                            parent_id: ID.M_SYS,
                            permission_code: 'system:user',
                            permission_name: '用户管理',
                            permission_type: 1,
                            menu_url: '/admin/users',
                            icon: 'UserOutlined',
                            sort: 1,
                        }),
                        makePerm({ id: ID.P_CREATE, permission_code: 'document:create', permission_type: 2, sort: 2 }),
                    ]);
                }
                // 第二次查询：全量启用菜单（用于祖先链与组树）
                return Promise.resolve([
                    makePerm({ id: ID.M_DASH, permission_code: 'dashboard', permission_name: '首页', permission_type: 1, menu_url: '/dashboard', sort: 1 }),
                    makePerm({ id: ID.M_DOC, permission_code: 'document', permission_name: '文档中心', permission_type: 1, menu_url: '/documents', sort: 2 }),
                    makePerm({ id: ID.M_SYS, permission_code: 'system', permission_name: '系统管理', permission_type: 1, menu_url: '/admin', sort: 5 }),
                    makePerm({ id: ID.M_USER, parent_id: ID.M_SYS, permission_code: 'system:user', permission_name: '用户管理', permission_type: 1, menu_url: '/admin/users', icon: 'UserOutlined', sort: 1 }),
                ]);
            });

            const overview = await svc.getPermissionOverview('1000000000000000002');

            expect(overview.codes).toEqual(expect.arrayContaining(['system:user', 'document:create']));
            // buttons 仅含按钮级（type=2），菜单码不混入
            expect(overview.buttons).toEqual(['document:create']);
            // 祖先链补全：用户未直接授权 system 根菜单，但因 system:user 命中而出现在树中；
            // dashboard/document 未授权给该用户，不得出现在其菜单树里
            const rootCodes = overview.menus.map((m) => m.permissionCode);
            expect(rootCodes).toEqual(['system']);
            const sys = overview.menus.find((m) => m.permissionCode === 'system')!;
            expect(sys.children.map((c) => c.permissionCode)).toEqual(['system:user']);
            expect(sys.children[0].menuUrl).toBe('/admin/users');
        });

        it('无任何菜单权限 → menus 为空数组（按钮码仍正常返回）', async () => {
            userRoleRepo.find.mockResolvedValue([{ role_id: ID.ROLE_REVIEWER }]);
            rolePermRepo.find.mockResolvedValue([{ permission_id: ID.P_CREATE }]);
            userPermRepo.find.mockResolvedValue([]);
            permRepo.find.mockImplementation(({ where }: { where: Record<string, unknown> }) => {
                if ('id' in where) {
                    return Promise.resolve([
                        makePerm({ id: ID.P_CREATE, permission_code: 'document:create', permission_type: 2 }),
                    ]);
                }
                return Promise.resolve([]);
            });

            const overview = await svc.getPermissionOverview('1000000000000000002');

            expect(overview.menus).toEqual([]);
            expect(overview.buttons).toEqual(['document:create']);
        });
    });
});
