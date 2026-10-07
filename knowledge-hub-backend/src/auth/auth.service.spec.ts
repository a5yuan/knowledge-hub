import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { AuthService } from './auth.service';
import { UserService } from './user.service';
import type { KhUser } from './entities/kh-user.entity';

/**
 * 鉴权核心语义测试：为什么重要——
 * 1) 登录失败必须统一返回「用户名或密码错误」，泄露「用户不存在」会给撞库者提供用户名枚举通道；
 * 2) refresh 接口必须拒绝 type=access 的 token（双 token 隔离：access 泄露后不能被拿去无限续期）；
 * 3) refresh 必须按 userId 重查用户，禁用/删除账号即使持有有效 refreshToken 也必须失效；
 * 4) expiresIn 必须与 JWT_ACCESS_EXPIRES 配置一致（前端据此安排静默刷新）；
 * 5) 未激活账号（email_verified=0）即使密码正确也必须 403 明确提示（邮箱注册激活流程图要求）。
 * 本组用例固化该约定：任何人放开枚举、混淆 token 类型、跳过用户重查、放行未激活账号，测试必须变红。
 * 密码比对使用 init.sql 预置账号的真实 bcrypt 哈希（明文 123456）。
 */
const TEST_SECRET = 'test-jwt-secret';
/** init.sql 预置密码 123456 的 bcrypt 哈希（cost=10） */
const SEEDED_HASH = '$2a$10$N.zmdr9k7uOCQb376NoUnuTJ8iAt6Z5EHsM8lE9lBOsl7iKTVKIUi';

const makeUser = (overrides: Partial<KhUser> = {}): KhUser =>
    ({
        id: '1000000000000000001',
        username: 'admin',
        password: SEEDED_HASH,
        email: 'admin@company.com',
        real_name: '系统管理员',
        avatar: null,
        email_verified: 1,
        status: 1,
        deleted: false,
        ...overrides,
    }) as KhUser;

describe('AuthService 登录与刷新语义', () => {
    let svc: AuthService;
    let userService: { findByUsername: jest.Mock; getRoleCodes: jest.Mock; updateLastLogin: jest.Mock; getUserWithRoles: jest.Mock };
    let jwt: JwtService;

    beforeEach(() => {
        jest.clearAllMocks();
        userService = {
            findByUsername: jest.fn(),
            getRoleCodes: jest.fn().mockResolvedValue(['ROLE_ADMIN', 'ROLE_REVIEWER']),
            updateLastLogin: jest.fn().mockResolvedValue(undefined),
            getUserWithRoles: jest.fn(),
        };
        jwt = new JwtService({ secret: TEST_SECRET, signOptions: { expiresIn: '2h' } });
        const config = {
            get: (key: string, def?: unknown) =>
                ({ JWT_ACCESS_EXPIRES: '2h', JWT_REFRESH_EXPIRES: '7d' })[key] ?? def,
        };
        svc = new AuthService(
            userService as unknown as UserService,
            jwt,
            config as unknown as ConfigService,
        );
    });

    describe('login', () => {
        it('成功：返回双 token + expiresIn=7200 + userInfo（含角色），并更新 lastLoginAt', async () => {
            userService.findByUsername.mockResolvedValueOnce(makeUser());

            const result = await svc.login({ username: 'admin', password: '123456' });

            expect(result.tokenType).toBe('Bearer');
            expect(result.expiresIn).toBe(7200);
            expect(result.userInfo).toEqual({
                userId: '1000000000000000001',
                username: 'admin',
                realName: '系统管理员',
                email: 'admin@company.com',
                avatar: null,
                roles: ['ROLE_ADMIN', 'ROLE_REVIEWER'],
            });
            // 双 token payload：sub/type 与流程图一致，且类型互异
            const access = jwt.verify(result.accessToken) as { sub: string; type: string };
            const refresh = jwt.verify(result.refreshToken) as { sub: string; type: string };
            expect(access).toMatchObject({ sub: '1000000000000000001', type: 'access' });
            expect(refresh).toMatchObject({ sub: '1000000000000000001', type: 'refresh' });
            expect(userService.updateLastLogin).toHaveBeenCalledWith('1000000000000000001');
        });

        it('用户不存在：401 且文案与「密码错误」一致（防用户名枚举）', async () => {
            userService.findByUsername.mockResolvedValueOnce(null);

            await expect(
                svc.login({ username: 'ghost', password: '123456' }),
            ).rejects.toMatchObject({
                constructor: UnauthorizedException,
                message: '用户名或密码错误',
            });
        });

        it('密码错误：401「用户名或密码错误」（真实 bcrypt 比对预置哈希）', async () => {
            userService.findByUsername.mockResolvedValueOnce(makeUser());

            await expect(
                svc.login({ username: 'admin', password: 'wrong-pass' }),
            ).rejects.toMatchObject({
                constructor: UnauthorizedException,
                message: '用户名或密码错误',
            });
        });

        it('邮箱未激活：即使密码正确也 403 明确提示（注册激活流程图要求）', async () => {
            userService.findByUsername.mockResolvedValueOnce(makeUser({ email_verified: 0, status: 0 }));

            await expect(
                svc.login({ username: 'admin', password: '123456' }),
            ).rejects.toMatchObject({
                constructor: ForbiddenException,
                message: '邮箱未激活，请查收激活邮件完成激活后再登录',
            });
            // 未激活账号不得签发 token
            expect(userService.updateLastLogin).not.toHaveBeenCalled();
        });

        it('账号被禁用：即使密码正确也 403「用户已被禁用」', async () => {
            userService.findByUsername.mockResolvedValueOnce(makeUser({ status: 0 }));

            await expect(
                svc.login({ username: 'admin', password: '123456' }),
            ).rejects.toMatchObject({
                constructor: ForbiddenException,
                message: '用户已被禁用',
            });
            // 禁用账号不得签发 token
            expect(userService.updateLastLogin).not.toHaveBeenCalled();
        });
    });

    describe('refresh', () => {
        const signRefresh = (type: 'access' | 'refresh') =>
            jwt.sign({ sub: '1000000000000000001', username: 'admin', type });

        it('有效 refreshToken：轮换签发新双 token，且按 userId 重查用户', async () => {
            userService.getUserWithRoles.mockResolvedValueOnce({
                userId: '1000000000000000001',
                username: 'admin',
                realName: '系统管理员',
                email: 'admin@company.com',
                avatar: null,
                roles: ['ROLE_ADMIN'],
            });

            const result = await svc.refresh({ refreshToken: signRefresh('refresh') });

            const access = jwt.verify(result.accessToken) as { sub: string; type: string };
            const refresh = jwt.verify(result.refreshToken) as { sub: string; type: string };
            expect(access.type).toBe('access');
            expect(refresh.type).toBe('refresh');
            expect(result.expiresIn).toBe(7200);
            expect(result.userInfo.roles).toEqual(['ROLE_ADMIN']);
            // 轮换语义：必须重查用户（禁用/删除即时失效），而非仅验签放行
            expect(userService.getUserWithRoles).toHaveBeenCalledWith('1000000000000000001');
        });

        it('传 accessToken 冒充 refreshToken：401（双 token 隔离，access 不得换新）', async () => {
            await expect(
                svc.refresh({ refreshToken: signRefresh('access') }),
            ).rejects.toMatchObject({
                constructor: UnauthorizedException,
                message: 'refreshToken 无效或已过期',
            });
            expect(userService.getUserWithRoles).not.toHaveBeenCalled();
        });

        it('伪造/损坏的 refreshToken：401', async () => {
            await expect(
                svc.refresh({ refreshToken: 'not-a-jwt-token' }),
            ).rejects.toMatchObject({
                constructor: UnauthorizedException,
                message: 'refreshToken 无效或已过期',
            });
        });

        it('用户已被禁用：即使 refreshToken 有效也 401（重查用户拦截）', async () => {
            userService.getUserWithRoles.mockRejectedValueOnce(
                new UnauthorizedException('用户不存在或已被禁用'),
            );

            await expect(
                svc.refresh({ refreshToken: signRefresh('refresh') }),
            ).rejects.toMatchObject({
                constructor: UnauthorizedException,
                message: '用户不存在或已被禁用',
            });
        });
    });
});
