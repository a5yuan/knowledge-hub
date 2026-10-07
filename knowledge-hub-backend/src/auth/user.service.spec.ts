import {
    BadRequestException,
    ConflictException,
    InternalServerErrorException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Repository } from 'typeorm';
import { UserService } from './user.service';
import { RedisService } from './redis.service';
import { MailService } from './mail.service';

/**
 * 注册激活与找回密码语义测试：为什么重要——
 * 1) REQUIRE_EMAIL_VERIFICATION=true 时注册必须写 email_verified=0 + status=0（未激活），否则用户跳过激活直接登录；
 * 2) 激活邮件发送失败必须回滚刚插入的用户，否则该账号既无法激活也无法重新注册（username 占用）——死锁；
 * 3) 重置验证码必须一次性：成功后立即删除，重放必须失败；错码不得消耗正确码；
 * 4) resend/send-code 对不存在的邮箱返回统一模糊提示（防枚举），但绝不给未激活/不匹配账号发信。
 * 本组用例固化该约定：任何人跳过未激活写入、漏掉回滚、放行验证码重放，测试必须变红。
 */
const makeConfig = (requireEmailVerification: boolean) =>
    ({
        get: (key: string, def?: unknown) =>
            ({ REQUIRE_EMAIL_VERIFICATION: String(requireEmailVerification) })[key] ?? def,
    }) as unknown as ConfigService;

/** 统一构造 mock 依赖与 service（requireEmailVerification 决定注册分叉） */
function makeService(requireEmailVerification: boolean) {
    const userRepo = {
        findOne: jest.fn().mockResolvedValue(null),
        find: jest.fn().mockResolvedValue([]),
        create: jest.fn((data: object) => data),
        save: jest.fn((data: object) => Promise.resolve(data)),
        update: jest.fn().mockResolvedValue({ affected: 1 }),
        delete: jest.fn().mockResolvedValue({ affected: 1 }),
    };
    const roleRepo = {
        // bindDefaultRole：默认角色 ROLE_USER 已预置
        findOne: jest.fn().mockResolvedValue({ id: '2000000000000000003', role_code: 'ROLE_USER' }),
    };
    const userRoleRepo = {
        create: jest.fn((data: object) => data),
        save: jest.fn((data: object) => Promise.resolve(data)),
        delete: jest.fn().mockResolvedValue({ affected: 1 }),
    };
    const redis = {
        get: jest.fn().mockResolvedValue(null),
        setex: jest.fn().mockResolvedValue(undefined),
        del: jest.fn().mockResolvedValue(undefined),
    };
    const mail = {
        sendActivationMail: jest.fn().mockResolvedValue(undefined),
        sendResetCodeMail: jest.fn().mockResolvedValue(undefined),
    };
    const svc = new UserService(
        userRepo as unknown as Repository<never>,
        roleRepo as unknown as Repository<never>,
        userRoleRepo as unknown as Repository<never>,
        redis as unknown as RedisService,
        mail as unknown as MailService,
        makeConfig(requireEmailVerification),
    );
    return { svc, userRepo, roleRepo, userRoleRepo, redis, mail };
}

describe('UserService 注册分叉（REQUIRE_EMAIL_VERIFICATION）', () => {
    it('false（默认）：email_verified=1/status=1 立即可登录，不发激活邮件（现状回归）', async () => {
        const { svc, userRepo, mail } = makeService(false);

        const result = await svc.register({ username: 'zhangsan', password: '123456', email: 'z@x.com' });

        expect(result.message).toBe('注册成功，请登录');
        const saved = userRepo.create.mock.calls[0][0] as Record<string, unknown>;
        expect(saved.email_verified).toBe(1);
        expect(saved.status).toBe(1);
        expect(mail.sendActivationMail).not.toHaveBeenCalled();
    });

    it('true：email_verified=0/status=0（未激活），Redis 存 token 并发送激活邮件', async () => {
        const { svc, userRepo, redis, mail } = makeService(true);

        const result = await svc.register({ username: 'zhangsan', password: '123456', email: 'Z@X.com' });

        expect(result.message).toBe('注册成功，请查收激活邮件并完成激活后再登录');
        const saved = userRepo.create.mock.calls[0][0] as Record<string, unknown>;
        expect(saved.email_verified).toBe(0);
        expect(saved.status).toBe(0);
        // 邮箱归一化小写存储
        expect(saved.email).toBe('z@x.com');
        // 激活 token 写 Redis（24h）并触发激活邮件
        expect(redis.setex).toHaveBeenCalledTimes(1);
        const [key, ttl] = redis.setex.mock.calls[0] as [string, number, string];
        expect(key).toMatch(/^email:activation:[0-9a-f]{48}$/);
        expect(ttl).toBe(24 * 60 * 60);
        expect(mail.sendActivationMail).toHaveBeenCalledWith('z@x.com', key.split(':')[2]);
    });

    it('true：email 缺失 → 400（无法发激活邮件的注册必须被拒绝）', async () => {
        const { svc } = makeService(true);

        await expect(
            svc.register({ username: 'zhangsan', password: '123456' }),
        ).rejects.toMatchObject({
            constructor: BadRequestException,
            message: '开启邮箱验证时，邮箱必填',
        });
    });

    it('true：邮箱已被注册 → 409', async () => {
        const { svc, userRepo } = makeService(true);
        userRepo.findOne.mockImplementation(({ where }: { where: Record<string, unknown> }) =>
            Promise.resolve(where.email ? { id: '1', email: where.email } : null),
        );

        await expect(
            svc.register({ username: 'zhangsan', password: '123456', email: 'taken@x.com' }),
        ).rejects.toMatchObject({
            constructor: ConflictException,
            message: '邮箱已被注册',
        });
    });

    it('true：激活邮件发送失败 → 回滚用户与角色绑定（防账号死锁）并 500', async () => {
        const { svc, userRepo, userRoleRepo, mail } = makeService(true);
        mail.sendActivationMail.mockRejectedValueOnce(new Error('SMTP connect timeout'));

        await expect(
            svc.register({ username: 'zhangsan', password: '123456', email: 'z@x.com' }),
        ).rejects.toMatchObject({
            constructor: InternalServerErrorException,
            message: '激活邮件发送失败，请稍后重试',
        });
        expect(userRepo.delete).toHaveBeenCalledTimes(1);
        expect(userRoleRepo.delete).toHaveBeenCalledTimes(1);
    });
});

describe('UserService 邮箱激活', () => {
    it('token 有效：消费 token 并将 email_verified/status 置 1（链接一次性）', async () => {
        const { svc, userRepo, redis } = makeService(true);
        redis.get.mockResolvedValueOnce('1000000000000000001');
        const user = { id: '1000000000000000001', email: 'z@x.com', email_verified: 0, status: 0, deleted: false };
        userRepo.findOne.mockResolvedValueOnce(user);

        const result = await svc.verifyEmail('a'.repeat(48));

        expect(result).toEqual({ ok: true, message: '邮箱激活成功，请直接登录' });
        expect(user.email_verified).toBe(1);
        expect(user.status).toBe(1);
        // token 必须被消费（重复点击失效）
        expect(redis.del).toHaveBeenCalledWith('email:activation:' + 'a'.repeat(48));
    });

    it('token 无效/过期/已使用：ok=false 且不写库', async () => {
        const { svc, userRepo, redis } = makeService(true);
        redis.get.mockResolvedValue(null);

        const result = await svc.verifyEmail('deadbeef');

        expect(result.ok).toBe(false);
        expect(userRepo.save).not.toHaveBeenCalled();
    });
});

describe('UserService 找回密码（验证码一次性）', () => {
    it('send-code：已激活账号 → 6 位数字码写 Redis（10 分钟）并发邮件', async () => {
        const { svc, redis, mail } = makeService(true);
        redis.get.mockResolvedValue(null);
        // findByEmail 命中已激活账号
        const userRepo = (svc as unknown as { userRepo: { findOne: jest.Mock } }).userRepo;
        userRepo.findOne.mockResolvedValueOnce({ id: '1', email_verified: 1, deleted: false });

        const result = await svc.sendResetCode('admin@company.com');

        expect(result.message).toBe('若该邮箱已注册，验证码已发送，10 分钟内有效');
        const [key, ttl, code] = redis.setex.mock.calls[0] as [string, number, string];
        expect(key).toBe('email:reset:admin@company.com');
        expect(ttl).toBe(10 * 60);
        expect(code).toMatch(/^\d{6}$/);
        expect(mail.sendResetCodeMail).toHaveBeenCalledWith('admin@company.com', code);
    });

    it('send-code：邮箱不存在（防枚举）→ 统一模糊提示且不发信不写 Redis', async () => {
        const { svc, redis, mail } = makeService(true);

        const result = await svc.sendResetCode('ghost@x.com');

        expect(result.message).toBe('若该邮箱已注册，验证码已发送，10 分钟内有效');
        expect(redis.setex).not.toHaveBeenCalled();
        expect(mail.sendResetCodeMail).not.toHaveBeenCalled();
    });

    it('reset：验证码正确 → 一次性消费（del）并 bcrypt 更新密码', async () => {
        const { svc, redis, userRepo } = makeService(true);
        redis.get.mockResolvedValueOnce('123456');

        const result = await svc.resetPassword('admin@company.com', '123456', 'new-pass-66');

        expect(result.message).toBe('密码重置成功，请使用新密码登录');
        // 验证码用后即删（重放必须失败）
        expect(redis.del).toHaveBeenCalledWith('email:reset:admin@company.com');
        const [, patch] = userRepo.update.mock.calls[0] as [unknown, { password: string }];
        expect(patch.password).toMatch(/^\$2[aby]\$/);
    });

    it('reset：验证码错误 → 400 且不消耗 Redis 中的正确码（错码不销毁验证机会）', async () => {
        const { svc, redis, userRepo } = makeService(true);
        redis.get.mockResolvedValueOnce('123456');

        await expect(
            svc.resetPassword('admin@company.com', '999999', 'new-pass-66'),
        ).rejects.toMatchObject({
            constructor: BadRequestException,
            message: '验证码错误或已过期',
        });
        expect(redis.del).not.toHaveBeenCalled();
        expect(userRepo.update).not.toHaveBeenCalled();
    });

    it('reset：验证码已过期（Redis 无值）→ 400', async () => {
        const { svc, redis } = makeService(true);
        redis.get.mockResolvedValueOnce(null);

        await expect(
            svc.resetPassword('admin@company.com', '123456', 'new-pass-66'),
        ).rejects.toMatchObject({ constructor: BadRequestException });
    });
});
