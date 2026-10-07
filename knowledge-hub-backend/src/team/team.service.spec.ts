import {
    BadRequestException,
    ConflictException,
    NotFoundException,
} from '@nestjs/common';
import { TeamService } from './team.service';
import type { AuthUser } from '../auth/interfaces/auth-user.interface';

/**
 * 团队服务语义测试：为什么重要——
 * 1) leader_id 必须缺省取建团人：建团即负责人是团队语义的默认约定，漏掉会让团队无主；
 * 2) 负责人/父团队不存在（FK 23503）必须转 400 明确提示，而不是 500 裸异常；
 * 3) 重复添加成员（UNIQUE 23505）必须 409：前端据此提示「已在团队中」而非报错崩溃；
 * 4) 成员不存在必须 404：区分「团队不存在」与「不是成员」两类失败；
 * 5) 软删团队必须从列表消失（deleted=false 过滤）：删除后知识库空间不可再被检索到。
 * 任何人破坏默认负责人、放行重复成员、或让软删团队仍可被查到，测试必须变红。
 */

const USER: AuthUser = {
    userId: '1000000000000000003',
    username: 'user',
    realName: '普通用户李四',
    email: null,
    avatar: null,
    roles: ['ROLE_USER'],
} as AuthUser;

describe('TeamService 团队 CRUD 与成员管理语义', () => {
    let svc: TeamService;
    let teamRepo: { create: jest.Mock; save: jest.Mock; findAndCount: jest.Mock; findOne: jest.Mock; update: jest.Mock };
    let memberRepo: { create: jest.Mock; save: jest.Mock; find: jest.Mock; findOne: jest.Mock; delete: jest.Mock };
    let userRepo: { find: jest.Mock };

    const savedTeam = {
        id: '8000000000000000009',
        team_name: '前端开发组',
        team_code: null,
        description: null,
        leader_id: USER.userId,
        parent_id: '0',
        sort: 0,
        status: 1,
        deleted: false,
    };

    beforeEach(() => {
        jest.clearAllMocks();
        teamRepo = {
            create: jest.fn((v) => v),
            save: jest.fn().mockResolvedValue(undefined),
            findAndCount: jest.fn().mockResolvedValue([[], 0]),
            findOne: jest.fn().mockResolvedValue(savedTeam),
            update: jest.fn().mockResolvedValue(undefined),
        };
        memberRepo = {
            create: jest.fn((v) => v),
            save: jest.fn().mockResolvedValue(undefined),
            find: jest.fn().mockResolvedValue([]),
            findOne: jest.fn().mockResolvedValue(null),
            delete: jest.fn().mockResolvedValue(undefined),
        };
        userRepo = { find: jest.fn().mockResolvedValue([]) };
        svc = new TeamService(teamRepo as never, memberRepo as never, userRepo as never);
    });

    it('create：leader_id 缺省取当前登录用户（建团人默认负责人）', async () => {
        await svc.create({ team_name: '前端开发组' }, USER);

        expect(teamRepo.create).toHaveBeenCalledWith(
            expect.objectContaining({ leader_id: '1000000000000000003', parent_id: '0' }),
        );
    });

    it('create：负责人不存在（FK 23503）→ 400 明确提示', async () => {
        teamRepo.save.mockRejectedValueOnce({ code: '23503' });

        await expect(
            svc.create({ team_name: 'x', leader_id: '999' }, USER),
        ).rejects.toThrow(BadRequestException);
    });

    it('addMember：重复成员（UNIQUE 23505）→ 409', async () => {
        memberRepo.save.mockRejectedValueOnce({ code: '23505' });

        await expect(
            svc.addMember('8000000000000000001', { user_id: '1000000000000000003' }),
        ).rejects.toThrow(ConflictException);
    });

    it('addMember：用户不存在（FK 23503）→ 400', async () => {
        memberRepo.save.mockRejectedValueOnce({ code: '23503' });

        await expect(
            svc.addMember('8000000000000000001', { user_id: '999' }),
        ).rejects.toThrow(BadRequestException);
    });

    it('removeMember：成员不存在 → 404（区分团队不存在与不是成员）', async () => {
        memberRepo.findOne.mockResolvedValueOnce(null);

        await expect(
            svc.removeMember('8000000000000000001', '1000000000000000003'),
        ).rejects.toThrow(NotFoundException);
    });

    it('updateMemberRole：leader→member 生效', async () => {
        memberRepo.findOne.mockResolvedValueOnce({
            id: '9000000000000000009',
            team_id: '8000000000000000001',
            user_id: USER.userId,
            member_role: 'leader',
        });

        const result = await svc.updateMemberRole('8000000000000000001', USER.userId, 'member');

        expect(memberRepo.save).toHaveBeenCalledWith(
            expect.objectContaining({ member_role: 'member' }),
        );
        expect(result.memberRole).toBe('member');
    });

    it('remove：软删（deleted=true update），非物理删除', async () => {
        const result = await svc.remove('8000000000000000009');

        expect(teamRepo.update).toHaveBeenCalledWith(
            { id: '8000000000000000009' },
            { deleted: true },
        );
        expect(result.message).toContain('已删除');
    });

    it('findAll：软删过滤固定 deleted=false，team_name 模糊匹配', async () => {
        await svc.findAll({ team_name: '开发', page: 1, pageSize: 20 });

        // Like() 在 TypeORM 中包装为 FindOperator（_type=like），断言其值而非字面量
        const { where } = teamRepo.findAndCount.mock.calls[0][0];
        expect(where).toMatchObject({ deleted: false });
        expect(where.team_name).toMatchObject({ _type: 'like', _value: '%开发%' });
    });

    it('findOne：团队不存在 → 404', async () => {
        teamRepo.findOne.mockResolvedValueOnce(null);

        await expect(svc.findOne('8000000000000000099')).rejects.toThrow(NotFoundException);
    });

    it('listMembers：联 kh_user 返回 username/realName；无成员返回空数组', async () => {
        memberRepo.find.mockResolvedValueOnce([
            { team_id: '8000000000000000001', user_id: '1000000000000000003', member_role: 'member', created_at: new Date() },
        ]);
        userRepo.find.mockResolvedValueOnce([
            { id: '1000000000000000003', username: 'user', real_name: '普通用户李四' },
        ]);

        const list = await svc.listMembers('8000000000000000001');

        expect(list).toHaveLength(1);
        expect(list[0]).toMatchObject({
            userId: '1000000000000000003',
            username: 'user',
            realName: '普通用户李四',
            memberRole: 'member',
        });
    });
});
