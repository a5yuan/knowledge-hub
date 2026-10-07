import { Controller, Get, Param, Query, NotFoundException } from '@nestjs/common';
import { DocIndexService } from '../es/doc-index.service';
import { isDocVisible } from '../es/visibility-scope';
import { SearchQueryDto } from './search.dto';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthUser } from '../auth/interfaces/auth-user.interface';
import { TeamService } from '../team/team.service';

/** 全文检索接口：对 ES 索引 kh_document 做文档级关键词检索（09 号工单：按当前用户可见性过滤） */
@Controller('search')
export class SearchController {
  constructor(
    private readonly docIndex: DocIndexService,
    private readonly teamService: TeamService,
  ) { }

  /** ES 详情：按 docId 从 kh_document 拉整篇快照（含 content 正文）；不存在或不可见均返回 404（不暴露存在性） */
  @Get('doc/:docId')
  async doc(@Param('docId') docId: string, @CurrentUser() user: AuthUser) {
    const doc = await this.docIndex.getDoc(docId);
    const scope = await this.teamService.resolveVisibilityScope(user);
    if (!doc || !isDocVisible(doc, scope)) {
      throw new NotFoundException(`ES 索引中不存在文档 docId=${docId}`);
    }
    return doc;
  }

  /**
   * 关键词检索已发布文档（title^2/summary/content，ik 中文分词；支持 operator/filter/highlight）
   * 09 号工单：登录用户可见性子句进同一 bool.filter——客户端 filter 只能收紧不能放宽
   */
  @Get()
  async search(@Query() dto: SearchQueryDto, @CurrentUser() user: AuthUser) {
    const scope = await this.teamService.resolveVisibilityScope(user);
    return this.docIndex.search(dto.q, dto.page, dto.pageSize, {
      operator: dto.operator,
      filters: {
        status: dto.status,
        is_public: dto.is_public,
        category_id: dto.category_id,
        team_id: dto.team_id,
        author_id: dto.author_id,
        tags: dto.tags,
      },
      visibility: scope,
    });
  }
}
