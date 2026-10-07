import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  Query,
  UploadedFile,
  UseInterceptors,
  BadRequestException,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { DocumentService } from './document.service';
import { CreateDocumentDto } from './dto/create-document.dto';
import { UpdateDocumentDto } from './dto/update-document.dto';
import { QueryDocumentDto } from './dto/query-document.dto';
import { UploadDocumentDto } from './dto/upload-document.dto';
import { ReviewActionDto } from './dto/review-action.dto';
import { Roles } from '../auth/decorators/roles.decorator';
import { RequirePermission } from '../auth/decorators/require-permission.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthUser } from '../auth/interfaces/auth-user.interface';
import { TeamService } from '../team/team.service';
import { ALLOWED_EXTENSIONS } from '../file/file.service';

@Controller('document')
export class DocumentController {
  constructor(
    private readonly documentService: DocumentService,
    private readonly teamService: TeamService,
  ) { }

  /**
   * 上传文件并提交异步解析（pdf/docx/pptx/xlsx/txt/md）
   * 立即返回草稿摘要 JSON，前端轮询 GET /document/:id
   */
  @Post('upload')
  @UseInterceptors(
    FileInterceptor('file', {
      // 对齐默认 flash 通道限制：≤10MB（切 self-hosted/cloud 可按需调大）
      limits: { fileSize: 10 * 1024 * 1024 },
    }),
  )
  upload(
    @CurrentUser() user: AuthUser,
    @UploadedFile() file?: Express.Multer.File,
    @Body() dto?: UploadDocumentDto,
  ) {
    if (!file) {
      throw new BadRequestException('缺少文件字段 file');
    }
    const ext = file.originalname.split('.').pop()?.toLowerCase() ?? '';
    if (!(ALLOWED_EXTENSIONS as readonly string[]).includes(ext)) {
      throw new BadRequestException(
        `不支持的文件格式 .${ext}，允许: ${ALLOWED_EXTENSIONS.join(', ')}`,
      );
    }
    return this.documentService.upload(file, dto, user);
  }

  /** 创建文档（需权限码 document:create，Admin 旁路；作者缺省取当前登录用户——09 号工单） */
  @RequirePermission('document:create')
  @Post()
  create(@Body() dto: CreateDocumentDto, @CurrentUser() user: AuthUser) {
    return this.documentService.create(dto, user);
  }

  /** 分页查询文档列表（09 号工单：按当前用户可见性过滤） */
  @Get()
  async findAll(@Query() query: QueryDocumentDto, @CurrentUser() user: AuthUser) {
    const scope = await this.teamService.resolveVisibilityScope(user);
    return this.documentService.findAll(query, scope);
  }

  /** 待审核数量（角标轮询用）。注意：必须注册在 @Get(':id') 之前，否则被 :id 吞掉 */
  @Get('reviews/pending/count')
  pendingCount() {
    return this.documentService.pendingReviewCount();
  }

  /** 审核待办列表（review_result IS NULL）。注意：必须注册在 @Get(':id') 之前 */
  @Get('reviews/pending')
  pending() {
    return this.documentService.pendingReviews();
  }

  /** 单文档审核历史（含通过/驳回） */
  @Get(':id/reviews')
  history(@Param('id') id: string) {
    return this.documentService.reviewHistory(id);
  }

  /** 查询文档详情（09 号工单：不可见与不存在同为 404，不暴露存在性） */
  @Get(':id')
  async findOne(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    const scope = await this.teamService.resolveVisibilityScope(user);
    return this.documentService.findOne(id, scope);
  }

  /** 更新文档元数据（需权限码 document:edit；审核开启时携带 status=1 会 400；关闭时 status 0→1 跳变触发投递） */
  @RequirePermission('document:edit')
  @Patch(':id')
  update(@Param('id') id: string, @Body() dto: UpdateDocumentDto) {
    return this.documentService.update(id, dto);
  }

  /**
   * 发布入口（按 REVIEW_ENABLED 分叉）：
   * false → 直接发布（status=1 + 投递 RAG/KG 队列 + Search 快照索引消息）
   * true  → 提审（status=2 + 审核记录；已发布重复提审会先清三套索引）
   */
  @Post(':id/publish')
  publish(@Param('id') id: string) {
    return this.documentService.publish(id);
  }

  /**
   * 审核通过（仅待审核，需 ROLE_REVIEWER / ROLE_ADMIN）：status=1 并投递 MQ 重建三套索引
   * 审核人身份取自 token 注入的当前登录用户
   */
  @Roles('ROLE_REVIEWER', 'ROLE_ADMIN')
  @RequirePermission('document:review')
  @Post(':id/approve')
  approve(
    @Param('id') id: string,
    @Body() dto: ReviewActionDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.documentService.approve(id, dto, user);
  }

  /**
   * 驳回（仅待审核，comment 必填，需 ROLE_REVIEWER / ROLE_ADMIN）：status=0 回草稿
   * 审核人身份取自 token 注入的当前登录用户
   */
  @Roles('ROLE_REVIEWER', 'ROLE_ADMIN')
  @RequirePermission('document:review')
  @Post(':id/reject')
  reject(
    @Param('id') id: string,
    @Body() dto: ReviewActionDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.documentService.reject(id, dto, user);
  }

  /** 下架编辑（仅已发布）：同步清三套索引后 status=0 回草稿 */
  @Post(':id/save-draft')
  saveDraft(@Param('id') id: string) {
    return this.documentService.saveDraft(id);
  }

  /** 归档（仅已发布）：status=3，三套索引异步清理，正文保留 */
  @Post(':id/archive')
  archive(@Param('id') id: string) {
    return this.documentService.archive(id);
  }

  /** 删除文档（逻辑删除，需权限码 document:delete） */
  @RequirePermission('document:delete')
  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.documentService.remove(id);
  }
}
