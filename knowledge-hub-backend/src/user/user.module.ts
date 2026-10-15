import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { UserAdminService } from './user.service';
import { UserController } from './user.controller';
import { KhUser } from '../auth/entities/kh-user.entity';
import { KhRole } from '../auth/entities/kh-role.entity';
import { KhUserRole } from '../auth/entities/kh-user-role.entity';
import { KhDepartment } from '../department/entities/kh-department.entity';

/**
 * 用户模块（管理端 CRUD，/user）
 * 三个鉴权域实体跨模块 forFeature 注册（角色关联读写 + 部门名校验），不 import AuthModule（无循环依赖）
 */
@Module({
    imports: [TypeOrmModule.forFeature([KhUser, KhRole, KhUserRole, KhDepartment])],
    controllers: [UserController],
    providers: [UserAdminService],
    exports: [UserAdminService],
})
export class UserModule {}
