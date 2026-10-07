import { Body, Controller, Delete, Get, Logger, Param, Post, Res } from '@nestjs/common';
import type { Response } from 'express';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthUser } from '../auth/interfaces/auth-user.interface';
import { AiAgentService } from './ai-agent.service';
import { AiSessionService } from './ai-session.service';
import { AiChatStreamDto, AiSessionCreateDto } from './dto/ai-chat.dto';
import { TeamService } from '../team/team.service';

/**
 * AI 会话接口（二期工单 08，登录即可访问——接口权限不做，延续现状）：
 * 会话 CRUD + POST /ai/sessions/messages（手写 SSE，UIMessage 形状事件）。
 * 旧 POST /ai/chat（单轮 RAG）保留在 rag/ai.controller.ts，不受影响。
 */
@Controller('ai')
export class AiController {
  private readonly logger = new Logger(AiController.name);

  constructor(
    private readonly sessions: AiSessionService,
    private readonly agent: AiAgentService,
    private readonly teamService: TeamService,
  ) { }

  /** 会话列表（updated_at DESC） */
  @Get('sessions')
  listSessions(@CurrentUser() user: AuthUser) {
    return this.sessions.listSessions(user.userId);
  }

  /** 显式新建会话（前端"新建对话"默认延迟到首条消息自动创建，此接口备用） */
  @Post('sessions')
  createSession(@CurrentUser() user: AuthUser, @Body() dto: AiSessionCreateDto) {
    return this.sessions.createSession(user.userId, dto.title);
  }

  /** 会话消息（进入会话时回放） */
  @Get('sessions/:id/messages')
  getMessages(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.sessions.getMessages(id, user.userId);
  }

  /** 删除会话（消息级联删除） */
  @Delete('sessions/:id')
  async deleteSession(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return await this.sessions.deleteSession(id, user.userId);
  }

  /** 清空对话（删消息保留会话壳） */
  @Delete('sessions/:id/messages')
  async clearMessages(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    await this.sessions.clearMessages(id, user.userId);
    return { id, cleared: true };
  }

  /** Agent 流式对话（手写 SSE + UIMessage 形状事件；自动建会话 + 历史窗口 + 工具降级） */
  @Post('sessions/messages')
  async streamChat(
    @CurrentUser() user: AuthUser,
    @Body() dto: AiChatStreamDto,
    @Res() res: Response,
  ): Promise<void> {
    this.logger.log(`AI 对话开始 user=${user.userId} session=${dto.sessionId ?? 'new'} model=${dto.model ?? 'default'}`);
    // 09 号工单：知识库检索工具按当前用户可见性过滤
    const scope = await this.teamService.resolveVisibilityScope(user);
    await this.agent.streamChat(res, user.userId, dto, scope);
  }
}
