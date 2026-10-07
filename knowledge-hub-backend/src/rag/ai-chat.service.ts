import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Response } from 'express';
import { ChatOpenAI } from '@langchain/openai';
import { SystemMessage, HumanMessage } from '@langchain/core/messages';
import { RagSearchService, RagSearchItem } from './rag-search.service';
import type { VisibilityScope } from '../es/visibility-scope';

const SYSTEM_PROMPT = `你是企业知识库的智能问答助手。请严格根据提供的参考文档回答用户问题。
要求：
1. 仅依据参考文档作答，不要编造文档中不存在的信息
2. 回答中用 [编号] 标注所引用参考文档的序号
3. 若参考文档不足以回答问题，明确说明知识库中暂无相关内容
4. 使用中文回答，语言简洁准确`;

/** SSE 事件：message=token 增量，done=完整答案+引用，error=失败提示 */
export type SseEvent = 'message' | 'done' | 'error';

/**
 * AI 问答服务（POST /ai/chat，SSE 流式）：
 * 复用 /rag/search 混合检索拿上下文 → 提示词 + 参考文档 → LLM(qwen-plus) 流式生成 → res.write 推送。
 * 手写 SSE 而非 @Sse()：该装饰器强制 GET 路由，question 需走 POST body（中文编码更稳）。
 */
@Injectable()
export class AiChatService {
  private readonly logger = new Logger(AiChatService.name);
  private llm?: ChatOpenAI;

  constructor(
    private readonly config: ConfigService,
    private readonly ragSearch: RagSearchService,
  ) {}

  /** 懒初始化 LLM（构造参数与 KG 抽取服务一致，复用 dashscope compatible-mode 端点） */
  private getLlm(): ChatOpenAI {
    if (this.llm) return this.llm;
    const baseUrl = this.config.get<string>('EMBEDDING_BASE_URL');
    const model = this.config.get<string>('LLM_MODEL', 'qwen-plus');
    const apiKey = this.config.get<string>('OPENAI_API_KEY');
    if (!baseUrl || !apiKey) {
      throw new Error('AI 问答配置缺失，需设置 EMBEDDING_BASE_URL / OPENAI_API_KEY');
    }
    this.llm = new ChatOpenAI({
      openAIApiKey: apiKey,
      modelName: model,
      temperature: 0,
      configuration: { baseURL: baseUrl },
    });
    return this.llm;
  }

  async chatStream(
    res: Response,
    question: string,
    topK: number,
    scope?: VisibilityScope,
  ): Promise<void> {
    this.writeSseHeaders(res);
    try {
      // 1. 混合检索上下文（启用重排；09 号工单：按用户可见性过滤）
      const { items } = await this.ragSearch.search(question, topK, true, scope);
      if (items.length === 0) {
        this.writeSse(res, 'done', {
          answer: '知识库中未找到与问题相关的内容，请换个问法或先补充相关文档。',
          sources: [],
        });
        return;
      }

      // 2. 提示词 + 参考文档，LLM 流式生成
      const context = items
        .map((it, i) => `[${i + 1}] (来源: ${it.doc_title})\n${it.content}`)
        .join('\n\n');
      const messages = [
        new SystemMessage(SYSTEM_PROMPT),
        new HumanMessage(`【参考文档】\n${context}\n\n【问题】${question}`),
      ];
      const stream = await this.getLlm().stream(messages);
      let answer = '';
      for await (const chunk of stream) {
        const delta = typeof chunk.content === 'string' ? chunk.content : '';
        if (!delta) continue;
        answer += delta;
        this.writeSse(res, 'message', { delta });
      }

      // 3. 结束事件：完整答案 + 引用列表（不含正文，正文可调 /rag/search 获取）
      const sources = items.map((it: RagSearchItem) => ({
        doc_id: it.doc_id,
        doc_title: it.doc_title,
        chunk_index: it.chunk_index,
        score: it.score,
        rank: it.rank,
      }));
      this.writeSse(res, 'done', { answer, sources });
      this.logger.log(
        `AI 问答完成 question=${question.slice(0, 50)} sources=${sources.length} answerLen=${answer.length}`,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(`AI 问答失败 question=${question.slice(0, 50)}: ${msg}`);
      this.writeSse(res, 'error', { message: 'AI 服务处理失败，请稍后重试' });
    } finally {
      res.end();
    }
  }

  private writeSseHeaders(res: Response): void {
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();
  }

  private writeSse(res: Response, event: SseEvent, data: unknown): void {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }
}
