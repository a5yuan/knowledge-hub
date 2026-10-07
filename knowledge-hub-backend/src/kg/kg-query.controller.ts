import { Controller, Get, Logger, Query } from '@nestjs/common';
import { DocIndexService } from '../es/doc-index.service';
import { KgService } from './kg.service';
import { EdgeSearchDto, GetOverviewDto, KgSearchDto, NodeSearchDto } from './kg-query.dto';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthUser } from '../auth/interfaces/auth-user.interface';
import { TeamService } from '../team/team.service';

/**
 * 知识图谱检索接口（对应架构图"图谱查询"）：
 * 全部用 Cypher 对节点属性做关键词匹配（toLower CONTAINS，不建索引）
 */
@Controller('kg')
export class KgQueryController {
  private readonly logger = new Logger(KgQueryController.name);

  constructor(
    private readonly kgService: KgService,
    private readonly docIndex: DocIndexService,
    private readonly teamService: TeamService,
  ) { }

  /** ⓪ 全景图谱总览（二期工单 07）：全量节点/边 + 统计 + 类型分布 + 热点 TOP5 一次下发 */
  @Get('overview')
  async overview(@Query() dto: GetOverviewDto) {
    const result = await this.kgService.getOverview(dto.limit);
    this.logger.log(
      `KG overview nodes=${result.nodes.length} edges=${result.edges.length} truncated=${!!result.truncated}`,
    );
    return result;
  }

  /** ① 聚合关键词搜索：docs=ES 全文检索（带 highlight，09 号工单：按用户可见性过滤），entities/edges/docEdges=Neo4j 图谱属性匹配（本期不过滤，见工单 Assumptions） */
  @Get('search')
  async search(@Query() dto: KgSearchDto, @CurrentUser() user: AuthUser) {
    const scope = await this.teamService.resolveVisibilityScope(user);
    const [docs, graph] = await Promise.all([
      this.docIndex.search(dto.q, dto.page, dto.pageSize, { visibility: scope }),
      this.kgService.searchGraph(dto.q, dto.type, dto.pageSize),
    ]);
    this.logger.log(`KG 聚合搜索 q=${dto.q} type=${dto.type ?? ''} docs=${docs.total} entities=${graph.entities.length} edges=${graph.edges.length} docEdges=${graph.docEdges.length}`);
    return { q: dto.q, docs, entities: graph.entities, edges: graph.edges, docEdges: graph.docEdges };
  }

  /** ② 通用节点查询：label=entity/document/chunk，关键词匹配对应节点属性，分页 */
  @Get('nodes')
  async searchNodes(@Query() dto: NodeSearchDto) {
    const result = await this.kgService.searchNodes(dto.label, dto.q ?? '', dto.type, dto.page, dto.pageSize);
    this.logger.log(`KG 节点查询 label=${dto.label} q=${dto.q ?? ''} type=${dto.type ?? ''} total=${result.total}`);
    return result;
  }

  /** ③ 通用关系查询：rel=related_to/mentions/has_chunk，可选实体名过滤边两端，分页 */
  @Get('edges')
  async searchEdges(@Query() dto: EdgeSearchDto) {
    const result = await this.kgService.searchEdges(dto.rel, dto.entity, dto.page, dto.pageSize);
    this.logger.log(`KG 关系查询 rel=${dto.rel} entity=${dto.entity ?? ''} total=${result.total}`);
    return result;
  }
}
