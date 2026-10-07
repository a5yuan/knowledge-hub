import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PermissionsGuard } from './permissions.guard';
import { PERMISSION_KEY } from '../decorators/require-permission.decorator';
import { ADMIN_ROLE_CODE } from '../permission.service';
import type { AuthUser } from '../interfaces/auth-user.interface';

/**
 * 全局权限 Guard 语义测试（对照图4 执行流程）：为什么重要——
 * 1) 未标注 @RequirePermission 的接口必须零开销放行（不触发权限查询）——权限校验是可选增强而非全局负担；
 * 2) ROLE_ADMIN 必须旁路：Admin 是超管，种子数据中无任何 role_permission 行，若不旁路 admin 将处处 403；
 * 3) 无 user 的请求放行：是否登录归 JwtAuthGuard 管（401），权限 Guard 不得越权拦截；
 * 4) any-of 命中放行 / 全部未命中 403：权限不足必须明确拒绝，防止越权调用（图3 接口级）。
 * 任何人放行未授权用户、对 admin 误拦截、或对未标注接口误查询，测试必须变红。
 */

const makeUser = (overrides: Partial<AuthUser> = {}): AuthUser =>
    ({
        userId: '1000000000000000003',
        username: 'user',
        realName: '普通用户李四',
        email: null,
        avatar: null,
        roles: ['ROLE_USER'],
        ...overrides,
    }) as AuthUser;

const makeContext = (request: { user?: AuthUser }): ExecutionContext =>
    ({
        getHandler: () => 'handler',
        getClass: () => 'class',
        switchToHttp: () => ({ getRequest: () => request }),
    }) as unknown as ExecutionContext;

describe('PermissionsGuard 权限码校验语义', () => {
    let guard: PermissionsGuard;
    let reflector: { getAllAndOverride: jest.Mock };
    let permissionService: { getUserPermissionCodes: jest.Mock };

    beforeEach(() => {
        jest.clearAllMocks();
        reflector = { getAllAndOverride: jest.fn() };
        permissionService = { getUserPermissionCodes: jest.fn().mockResolvedValue([]) };
        guard = new PermissionsGuard(
            reflector as unknown as Reflector,
            permissionService as never,
        );
    });

    it('未标注 @RequirePermission → 放行且不查询权限（未标注接口零开销）', async () => {
        reflector.getAllAndOverride.mockReturnValue(undefined);

        const ok = await guard.canActivate(makeContext({ user: makeUser() }));

        expect(ok).toBe(true);
        expect(permissionService.getUserPermissionCodes).not.toHaveBeenCalled();
    });

    it('ROLE_ADMIN 旁路：直接放行，不查询权限（种子无 admin 授权行也全通过）', async () => {
        reflector.getAllAndOverride.mockReturnValue(['document:delete']);

        const ok = await guard.canActivate(
            makeContext({ user: makeUser({ userId: '1000000000000000001', roles: [ADMIN_ROLE_CODE] }) }),
        );

        expect(ok).toBe(true);
        expect(permissionService.getUserPermissionCodes).not.toHaveBeenCalled();
    });

    it('request.user 不存在（@Public 异常组合）→ 放行，401 归 JwtAuthGuard 管', async () => {
        reflector.getAllAndOverride.mockReturnValue(['document:create']);

        const ok = await guard.canActivate(makeContext({}));

        expect(ok).toBe(true);
        expect(permissionService.getUserPermissionCodes).not.toHaveBeenCalled();
    });

    it('命中任一所需权限码（any-of）→ 放行', async () => {
        reflector.getAllAndOverride.mockReturnValue(['document:create', 'document:edit']);
        permissionService.getUserPermissionCodes.mockResolvedValue([
            'document:list',
            'document:create',
        ]);

        const ok = await guard.canActivate(makeContext({ user: makeUser() }));

        expect(ok).toBe(true);
        expect(permissionService.getUserPermissionCodes).toHaveBeenCalledWith('1000000000000000003');
    });

    it('权限码全部未命中 → 403 权限不足（防越权调用）', async () => {
        reflector.getAllAndOverride.mockReturnValue(['document:delete']);
        permissionService.getUserPermissionCodes.mockResolvedValue(['document:list']);

        await expect(
            guard.canActivate(makeContext({ user: makeUser() })),
        ).rejects.toThrow(ForbiddenException);
    });

    it('元数据 key 固定为 PERMISSION_KEY（装饰器与 Guard 契约）', async () => {
        reflector.getAllAndOverride.mockReturnValue(undefined);
        await guard.canActivate(makeContext({ user: makeUser() }));

        expect(reflector.getAllAndOverride).toHaveBeenCalledWith(PERMISSION_KEY, [
            'handler',
            'class',
        ]);
    });
});
