import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DepartmentService } from './department.service';
import { DepartmentController } from './department.controller';
import { KhDepartment } from './entities/kh-department.entity';
import { KhUser } from '../auth/entities/kh-user.entity';

/**
 * 部门模块：部门 CRUD（树形，软删）
 * KhUser 跨模块 forFeature 注册（删除时的用户归属保护 + 树组装），不 import AuthModule（无循环依赖）
 */
@Module({
    imports: [TypeOrmModule.forFeature([KhDepartment, KhUser])],
    controllers: [DepartmentController],
    providers: [DepartmentService],
    exports: [DepartmentService],
})
export class DepartmentModule {}
