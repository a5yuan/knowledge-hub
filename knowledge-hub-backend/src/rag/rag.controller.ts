import { Controller, Get, Query } from '@nestjs/common';
import { RagSearchService } from './rag-search.service';
import { RagSearchDto } from './dto/rag-search.dto';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthUser } from '../auth/interfaces/auth-user.interface';
import { TeamService } from '../team/team.service';

/** RAG 混合检索（关键词 + 向量 → RRF → Reranker；09 号工单：召回阶段按用户可见性过滤） */
@Controller('rag')
export class RagController {
  constructor(
    private readonly ragSearch: RagSearchService,
    private readonly teamService: TeamService,
  ) {}

  @Get('search')
  async search(@Query() dto: RagSearchDto, @CurrentUser() user: AuthUser) {
    const scope = await this.teamService.resolveVisibilityScope(user);
    return this.ragSearch.search(dto.q, dto.top_k, dto.rerank, scope);
  }
}
