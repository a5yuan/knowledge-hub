import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { TeamService } from './team.service';
import { TeamController } from './team.controller';
import { KhTeam } from './entities/kh-team.entity';
import { KhTeamMember } from './entities/kh-team-member.entity';
import { KhUser } from '../auth/entities/kh-user.entity';

/**
 * 团队模块：团队 CRUD + 成员管理
 * KhUser 跨模块 forFeature 注册（成员列表联查），不 import AuthModule（无循环依赖）
 */
@Module({
    imports: [TypeOrmModule.forFeature([KhTeam, KhTeamMember, KhUser])],
    controllers: [TeamController],
    providers: [TeamService],
    // 导出 TeamService 供检索/文档模块派生可见性作用域（09 号工单）
    exports: [TeamService],
})
export class TeamModule {}
