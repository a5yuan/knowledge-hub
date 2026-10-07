import { Module } from '@nestjs/common';
import { MineruService } from './mineru.service';

/**
 * MinerU 接入模块
 *
 * 前置：AppModule 里要有 ConfigModule.forRoot({ isGlobal: true })，
 * 因为 MineruService 直接读 MINERU_* 环境变量。
 */
@Module({
  providers: [MineruService],
  exports: [MineruService],
})
export class MineruModule {}
