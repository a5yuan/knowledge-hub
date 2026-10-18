import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { OperationController } from './operation.controller';
import { OperationService } from './operation.service';
import { KhOperationLog } from './entities/kh-operation-log.entity';

/**
 * 操作日志模块（19 号工单）。
 *
 * `exports: [OperationService]` 是本模块的**核心职责** —— 埋点分散在
 * Document / Auth / Ai / User / Team / Folder 六个模块，它们都只依赖这一个 service。
 *
 * ⚠️ 防循环依赖：本模块**不得**反向导入上述任何模块（尤其不能注入 UserService 取用户名）。
 * 用户名由调用方从 `AuthUser` 传入，`OperationService` 只依赖自己的仓库。
 */
@Module({
  imports: [TypeOrmModule.forFeature([KhOperationLog])],
  controllers: [OperationController],
  providers: [OperationService],
  exports: [OperationService],
})
export class OperationModule {}
