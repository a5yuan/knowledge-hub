import { Body, Controller, Post, Res } from '@nestjs/common';
import type { Response } from 'express';
import { AiChatService } from './ai-chat.service';
import { RagChatDto } from './dto/rag-chat.dto';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthUser } from '../auth/interfaces/auth-user.interface';
import { TeamService } from '../team/team.service';

/** AI 问答（SSE 流式：message 增量 → done 完整答案+引用；09 号工单：检索上下文按用户可见性过滤） */
@Controller('ai')
export class AiController {
  constructor(
    private readonly aiChat: AiChatService,
    private readonly teamService: TeamService,
  ) {}

  @Post('chat')
  async chat(
    @Res() res: Response,
    @Body() dto: RagChatDto,
    @CurrentUser() user: AuthUser,
  ) {
    const scope = await this.teamService.resolveVisibilityScope(user);
    await this.aiChat.chatStream(res, dto.question, dto.top_k, scope);
  }
}
