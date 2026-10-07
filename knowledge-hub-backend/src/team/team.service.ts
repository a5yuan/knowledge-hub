import {
    BadRequestException,
    ConflictException,
    Injectable,
    Logger,
    NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { FindOptionsWhere, In, Like, Repository } from 'typeorm';
import SnowflakeId from 'snowflake-id';
import { KhTeam } from './entities/kh-team.entity';
import { KhTeamMember } from './entities/kh-team-member.entity';
import { KhUser } from '../auth/entities/kh-user.entity';
import { CreateTeamDto } from './dto/create-team.dto';
import { UpdateTeamDto } from './dto/update-team.dto';
import { QueryTeamDto } from './dto/query-team.dto';
import { AddTeamMemberDto } from './dto/team-member.dto';
import { normalizeSnowflakeId } from '../common/utils/snowflake-id.util';
import type { AuthUser } from '../auth/interfaces/auth-user.interface';
import type { VisibilityScope } from '../es/visibility-scope';

/** 成员条目（GET /team/:id/members 返回，联 kh_user 展示姓名） */
export interface TeamMemberView {
    userId: string;
    username: string;
    realName: string | null;
    memberRole: string;
    joinedAt: Date;
}

/**
 * 团队模块服务：团队 CRUD（软删）+ 成员管理（增删查改）
 * 雪花ID 应用侧生成；异常码兜底：23503 FK → 400，23505 UNIQUE → 409
 */
@Injectable()
export class TeamService {
    private readonly logger = new Logger(TeamService.name);
    private readonly snowflake = new SnowflakeId();

    constructor(
        @InjectRepository(KhTeam)
        private readonly teamRepo: Repository<KhTeam>,
        @InjectRepository(KhTeamMember)
        private readonly memberRepo: Repository<KhTeamMember>,
        @InjectRepository(KhUser)
        private readonly userRepo: Repository<KhUser>,
    ) {}

    /** 创建团队：leader_id 缺省为建团人；负责人/父团队不存在（FK 23503）→ 400 */
    async create(dto: CreateTeamDto, user: AuthUser) {
        const id = this.snowflake.generate();
        try {
            await this.teamRepo.save(
                this.teamRepo.create({
                    id,
                    team_name: dto.team_name,
                    team_code: dto.team_code ?? null,
                    description: dto.description ?? null,
                    leader_id: dto.leader_id ?? user.userId,
                    parent_id: dto.parent_id ?? '0',
                    sort: dto.sort ?? 0,
                }),
            );
        } catch (err) {
            if (err?.code === '23503') {
                throw new BadRequestException('负责人或父团队不存在');
            }
            throw err;
        }
        this.logger.log(`团队创建成功 teamId=${id} teamName=${dto.team_name} leader=${dto.leader_id ?? user.userId}`);
        return this.findOne(id);
    }

    /** 分页查询（软删团队不出现；team_name 模糊，其余等值） */
    async findAll(query: QueryTeamDto) {
        const { team_name, team_code, leader_id, status, page, pageSize } = query;
        const where: FindOptionsWhere<KhTeam> = { deleted: false };
        if (team_name !== undefined) where.team_name = Like(`%${team_name}%`);
        if (team_code !== undefined) where.team_code = team_code;
        if (leader_id !== undefined) where.leader_id = leader_id;
        if (status !== undefined) where.status = status;
        const [items, total] = await this.teamRepo.findAndCount({
            where,
            order: { sort: 'ASC', created_at: 'DESC' },
            skip: (page - 1) * pageSize,
            take: pageSize,
        });
        return { items, total, page, pageSize };
    }

    /** 团队详情（未删），404 兜底 */
    async findOne(id: string) {
        const teamId = normalizeSnowflakeId(id, 'id');
        const team = await this.teamRepo.findOne({
            where: { id: teamId, deleted: false },
        });
        if (!team) {
            throw new NotFoundException(`团队 ${teamId} 不存在`);
        }
        return team;
    }

    /** 更新团队（部分更新），404 兜底 */
    async update(id: string, dto: UpdateTeamDto) {
        const team = await this.findOne(id);
        if (dto.team_name !== undefined) team.team_name = dto.team_name;
        if (dto.team_code !== undefined) team.team_code = dto.team_code;
        if (dto.description !== undefined) team.description = dto.description;
        if (dto.leader_id !== undefined) team.leader_id = dto.leader_id;
        if (dto.parent_id !== undefined) team.parent_id = dto.parent_id;
        if (dto.sort !== undefined) team.sort = dto.sort;
        if (dto.status !== undefined) team.status = dto.status;
        try {
            await this.teamRepo.save(team);
        } catch (err) {
            if (err?.code === '23503') {
                throw new BadRequestException('负责人或父团队不存在');
            }
            throw err;
        }
        this.logger.log(`团队更新成功 teamId=${team.id}`);
        return this.findOne(team.id);
    }

    /** 删除团队（软删）：成员关联行不动，查询以 deleted=false 为准 */
    async remove(id: string) {
        const team = await this.findOne(id);
        await this.teamRepo.update({ id: team.id }, { deleted: true });
        this.logger.log(`团队已删除（软删）teamId=${team.id}`);
        return { id: team.id, message: '团队已删除' };
    }

    /** 添加成员：团队须存在且未删；重复添加（UNIQUE 23505）→ 409 */
    async addMember(teamId: string, dto: AddTeamMemberDto) {
        const team = await this.findOne(teamId);
        const userId = normalizeSnowflakeId(dto.user_id, 'user_id');
        try {
            await this.memberRepo.save(
                this.memberRepo.create({
                    id: this.snowflake.generate(),
                    team_id: team.id,
                    user_id: userId,
                    member_role: dto.member_role ?? 'member',
                }),
            );
        } catch (err) {
            if (err?.code === '23505') {
                throw new ConflictException(`用户 ${userId} 已是团队成员`);
            }
            if (err?.code === '23503') {
                throw new BadRequestException('用户不存在');
            }
            throw err;
        }
        this.logger.log(`团队成员添加成功 teamId=${team.id} userId=${userId} role=${dto.member_role ?? 'member'}`);
        return { teamId: team.id, userId, memberRole: dto.member_role ?? 'member', message: '成员添加成功' };
    }

    /** 成员列表：联 kh_user 返回 username/realName（成员行硬删，无软删过滤） */
    async listMembers(teamId: string): Promise<TeamMemberView[]> {
        const id = normalizeSnowflakeId(teamId, 'id');
        await this.findOne(id); // 团队不存在/已删 → 404
        const members = await this.memberRepo.find({ where: { team_id: id } });
        if (members.length === 0) return [];
        const users = await this.userRepo.find({
            where: { id: In(members.map((m) => m.user_id)) },
        });
        const byId = new Map(users.map((u) => [u.id, u]));
        return members.map((m) => ({
            userId: m.user_id,
            username: byId.get(m.user_id)?.username ?? '(用户不存在)',
            realName: byId.get(m.user_id)?.real_name ?? null,
            memberRole: m.member_role,
            joinedAt: m.created_at,
        }));
    }

    /** 调整成员角色（leader/member），成员不存在 → 404 */
    async updateMemberRole(teamId: string, userId: string, memberRole: 'leader' | 'member') {
        const member = await this.findMemberOrFail(teamId, userId);
        member.member_role = memberRole;
        await this.memberRepo.save(member);
        this.logger.log(`成员角色调整 teamId=${member.team_id} userId=${member.user_id} role=${memberRole}`);
        return { teamId: member.team_id, userId: member.user_id, memberRole, message: '成员角色已更新' };
    }

    /** 移除成员（硬删关联行），成员不存在 → 404 */
    async removeMember(teamId: string, userId: string) {
        const member = await this.findMemberOrFail(teamId, userId);
        await this.memberRepo.delete({ id: member.id });
        this.logger.log(`团队成员移除 teamId=${member.team_id} userId=${member.user_id}`);
        return { teamId: member.team_id, userId: member.user_id, message: '成员已移除' };
    }

    /**
     * 查询用户所属团队 ID 列表（09 号工单：可见性过滤的 teamIds 数据源）
     * 联 kh_team 过滤软删团队；命中 idx_kh_team_member_user_id 索引
     */
    async getUserTeamIds(userId: string): Promise<string[]> {
        const uid = normalizeSnowflakeId(userId, 'userId');
        const rows = await this.memberRepo
            .createQueryBuilder('m')
            .innerJoin(KhTeam, 't', 't.id = m.team_id AND t.deleted = false')
            .where('m.user_id = :uid', { uid })
            .select('m.team_id', 'team_id')
            .getRawMany<{ team_id: string }>();
        return rows.map((r) => r.team_id);
    }

    /**
     * 由登录用户派生可见性作用域（检索三条链路 + 文档列表/详情共用入口）：
     * admin 免过滤不查团队表；canReview 覆盖 admin 与 ROLE_REVIEWER
     */
    async resolveVisibilityScope(user: AuthUser): Promise<VisibilityScope> {
        const isAdmin = user.roles.includes('ROLE_ADMIN');
        const teamIds = isAdmin ? [] : await this.getUserTeamIds(user.userId);
        return {
            userId: user.userId,
            teamIds,
            isAdmin,
            canReview: isAdmin || user.roles.includes('ROLE_REVIEWER'),
        };
    }

    /** 按 team_id + user_id 定位成员行，不存在 → 404 */
    private async findMemberOrFail(teamId: string, userId: string): Promise<KhTeamMember> {
        const tid = normalizeSnowflakeId(teamId, 'id');
        const uid = normalizeSnowflakeId(userId, 'userId');
        await this.findOne(tid); // 团队不存在/已删 → 404
        const member = await this.memberRepo.findOne({
            where: { team_id: tid, user_id: uid },
        });
        if (!member) {
            throw new NotFoundException(`用户 ${uid} 不是团队 ${tid} 的成员`);
        }
        return member;
    }
}
