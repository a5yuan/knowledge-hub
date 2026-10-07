import { Module } from '@nestjs/common';
import { RagController } from './rag.controller';
import { AiController } from './ai.controller';
import { RagSearchService } from './rag-search.service';
import { AiChatService } from './ai-chat.service';
import { RerankService } from './rerank.service';
import { EmbeddingService } from '../pipeline/embedding.service';
import { TeamModule } from '../team/team.module';

/**
 * RAG 检索问答模块：/rag/search 混合检索 + /ai/chat SSE 问答。
 * EsService/VectorIndexService 由全局 EsModule 提供，ConfigService 全局；
 * EmbeddingService 无状态，此处直接实例化（PipelineModule 未导出，避免侵入）；
 * TeamModule 供可见性作用域派生（09 号工单）。
 */
@Module({
  imports: [TeamModule],
  controllers: [RagController, AiController],
  providers: [RagSearchService, AiChatService, RerankService, EmbeddingService],
  // 导出检索服务供 AiModule 复用（二期工单 08：retrieve_knowledge 工具数据源）
  exports: [RagSearchService],
})
export class RagModule {}
