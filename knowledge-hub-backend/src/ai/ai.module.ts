import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AiController } from './ai.controller';
import { AiAgentService } from './ai-agent.service';
import { AiSessionService } from './ai-session.service';
import { Mem0Service } from './mem0.service';
import { MemoryCacheService } from './memory-cache.service';
import { KhAiSession } from './entities/ai-session.entity';
import { KhAiMessage } from './entities/ai-message.entity';
import { RagModule } from '../rag/rag.module';
import { KgModule } from '../kg/kg.module';
import { TeamModule } from '../team/team.module';
import { AuthModule } from '../auth/auth.module';

/**
 * AI 会话模块（二期工单 08/10；12 号：KgModule 导入供 retrieve_graph 工具）：
 * 会话历史（kh_ai_session/kh_ai_message）+ LangAgent 流式编排（tool-calling 手写循环）
 * + 记忆管线（工单 10：Redis 短期窗口 + Mem0 长期记忆 + 前置检索管线）。
 * RagSearchService 经 RagModule 导出复用（retrieve_knowledge 工具数据源）；
 * KgService 经 KgModule 导出复用（retrieve_graph 工具数据源，12 号工单）；
 * ConfigService 全局；RedisService 经 AuthModule 导出复用；
 * 全局 Guard 链（JwtAuthGuard 等）自动生效——登录即可访问；
 * TeamModule 供检索可见性作用域派生（09 号工单）。
 */
@Module({
  imports: [TypeOrmModule.forFeature([KhAiSession, KhAiMessage]), RagModule, KgModule, TeamModule, AuthModule],
  controllers: [AiController],
  providers: [AiSessionService, AiAgentService, Mem0Service, MemoryCacheService],
})
export class AiModule { }
