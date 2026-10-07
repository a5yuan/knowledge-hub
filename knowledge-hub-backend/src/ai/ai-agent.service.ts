import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Response } from 'express';
import { ChatOpenAI } from '@langchain/openai';
import {
  AIMessage,
  HumanMessage,
  SystemMessage,
  ToolMessage,
} from '@langchain/core/messages';
import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import { RagSearchService } from '../rag/rag-search.service';
import { KgService } from '../kg/kg.service';
import type { VisibilityScope } from '../es/visibility-scope';
import { AiSessionService, AiSourceV2 as AiSource } from './ai-session.service';
import { MemoryCacheService } from './memory-cache.service';
import { Mem0Service, Mem0Hit } from './mem0.service';
import {
  TracingService,
  type ChatTrace,
} from '../observability/tracing.service';

/** 引用来源（工具登记时不含 index，finalSources 统一编号） */
type AiSourceDraft = Omit<AiSource, 'index'>;

/** v2 事件类型（单通道 data: JSON，type 内嵌；工单 10 新增 data-memory，12 号新增 data-graph） */
export type AiStreamEvent =
  | 'start'
  | 'data-session'
  | 'start-step'
  | 'data-status'
  | 'data-plan'
  | 'data-memory'
  | 'data-retrieve'
  | 'data-web-search'
  | 'data-graph'
  | 'reasoning-start'
  | 'reasoning-delta'
  | 'reasoning-end'
  | 'text-start'
  | 'text-delta'
  | 'text-end'
  | 'data-sources'
  | 'finish'
  | 'error';

/** Agent 循环硬上限（防死循环兜底；主控为 11/12 号工单预算 4 工具各 1 次） */
const MAX_ITERATIONS = 5;
/** 11/12 号工单：单轮工具调用预算（代码强制，不依赖 prompt 遵从）；12 号图谱加入后总预算 4 */
const MAX_TOOL_CALLS = 4;
const MAX_REWRITE_CALLS = 1;
const MAX_WEB_CALLS = 1;
const MAX_GRAPH_CALLS = 1;
/** 图谱检索截断（12 号工单：实体/关系上限，防上下文膨胀） */
const GRAPH_ENTITY_LIMIT = 8;
const GRAPH_RELATION_LIMIT = 10;
/** Tavily 请求超时 */
const TAVILY_TIMEOUT_MS = 8000;
/** 来源摘要截断长度 */
const EXCERPT_LEN = 120;

/** 11 号工单：五类意图（阶段1 意图路由 Planner） */
type AgentIntent =
  'chitchat' | 'preference' | 'knowledge' | 'web' | 'knowledge_then_web';
const VALID_INTENTS = new Set<string>([
  'chitchat',
  'preference',
  'knowledge',
  'web',
  'knowledge_then_web',
]);
const INTENT_LABELS: Record<AgentIntent, string> = {
  chitchat: '闲聊',
  preference: '个人偏好',
  knowledge: '知识库',
  web: '联网',
  knowledge_then_web: '知识库不足再联网',
};
/** 11 号工单：切题评估三态（none=无资料，由 overallGrade 派生） */
type ChunkGrade = 'on_topic' | 'partial' | 'off_topic';
const VALID_GRADES = new Set<string>(['on_topic', 'partial', 'off_topic']);
/** 阶段1 意图路由输出 */
interface PlanResult {
  intent: AgentIntent;
  rewrittenQuery: string;
  suggestedTerms: string[];
  needRetrieve: boolean;
  isChitchat: boolean;
}

const SYSTEM_PROMPT = `你是企业智能知识库的 AI 问答助手，可用工具由本轮意图门控决定：
1. retrieve_knowledge：检索企业知识库并自动做切题评估，返回评估结论（切题/部分相关/不切题/无结果）与全局编号的切题资料
2. retrieve_graph：检索企业知识图谱中的实体关系子图（人/组织/术语等实体及关联），适合回答「实体之间的关系、谁审批、谁归属哪个流程」类问题，作为文档检索的补充（每轮最多 1 次）
3. rewrite_query：改写检索词后重新检索（仅在评估不足时使用，每轮最多 1 次；是否改写、用什么词由你决定）
4. web_search：搜索公网信息（仅知识库不足且允许联网时使用，每轮最多 1 次）
工具调用预算：单轮最多 4 次工具调用，各类工具每轮 1 次，预算耗尽必须立即基于已有信息回答。
要求：
- 回答使用中文、markdown 格式，简洁准确
- 只依据资料中实际给出的内容作答，每处依据句尾标 [n]（n 为资料全局编号，图谱关系同样有编号）
- 知识库确实没有相关信息时明确告知用户「知识库中未检索到相关信息」，禁止用记忆或制度背景编造
- 引用 Web 结果时在句末以 (来源: 域名) 标注
- 工具不可用或无结果时如实告知，不要编造；若问题无需工具（闲聊、个人偏好），直接回答
上下文可能附带【用户长期记忆】【当前会话记忆】【早期对话摘要】【知识库检索资料】【知识图谱实体关系】等参考信息：
- 检索资料已通过切题评估，可信优先使用并按全局编号标 [n]；资料不足时调 retrieve_knowledge，或用 rewrite_query 改写后再查
- 图谱实体关系描述实体间的审批、归属、关联等事实，回答此类问题优先引用对应 [n]
- 记忆与摘要仅作为回答的背景参考，不要向用户复述其内容`;

/** suggestions 生成失败时的固定兜底池 */
const FALLBACK_SUGGESTIONS = [
  '知识库里还有哪些相关文档？',
  '能总结一下要点吗？',
  '这个问题在哪些文档中提到过？',
  '有没有相关的操作流程？',
  '请展开说明第 2 点',
  '给一个实际示例',
];

/** 流式请求参数（controller 校验后的结构） */
export interface AiChatStreamParams {
  content: string;
  sessionId?: string;
  model?: string;
  temperature?: number;
  /** 深度思考：true 时模型切 qwen-plus-latest + enable_thinking，输出 reasoning 流 */
  enableThinking?: boolean;
}

/**
 * AI Agent 编排服务（二期工单 08 v2，POST /ai/sessions/messages SSE）：
 * - 单通道事件：`data: {"type":"...","data":{...}}`（AI SDK UIMessage Stream Protocol 形状）
 * - LangChain tool-calling 手写 while 循环；reasoning 思考流（qwen thinking）；失败全降级不报错
 * - 11 号工单 Agentic RAG：五类意图路由（data-plan）/ 切题评估 / rewrite_query 环内改写 /
 *   工具预算 3/1/1 代码强制 / 仅切题资料进上下文 / [n] 引用过滤 data-sources
 */
@Injectable()
export class AiAgentService {
  private readonly logger = new Logger(AiAgentService.name);

  constructor(
    private readonly config: ConfigService,
    private readonly ragSearch: RagSearchService,
    private readonly kg: KgService,
    private readonly sessions: AiSessionService,
    private readonly memoryCache: MemoryCacheService,
    private readonly mem0: Mem0Service,
    private readonly tracing: TracingService,
  ) { }

  /**
   * 流式对话入口（工单 13）：外层包一个 Langfuse trace（agent 类型），
   * 内部 LangChain 调用自动嵌套其下；tracing 未启用/降级时行为与现状完全一致。
   */
  async streamChat(
    res: Response,
    userId: string,
    params: AiChatStreamParams,
    scope?: VisibilityScope,
  ): Promise<void> {
    await this.tracing.runChat({ userId, question: params.content }, (trace) =>
      this.streamChatInner(res, userId, params, scope, trace),
    );
  }

  /**
   * 流式对话主实现（09 号工单：scope 透传给 retrieve_knowledge 的混合检索）
   */
  private async streamChatInner(
    res: Response,
    userId: string,
    params: AiChatStreamParams,
    scope: VisibilityScope | undefined,
    trace: ChatTrace,
  ): Promise<void> {
    this.writeSseHeaders(res);
    let aborted = false;
    res.on('close', () => {
      aborted = true;
    });

    try {
      // 1. 会话：不存在则自动创建（title=首问前 20 字）
      const sessionId = await this.sessions.ensureSession(
        params.sessionId,
        userId,
        params.content,
      );
      // 工单 13：会话确定后登记 trace 的 session 分组，并惰性创建本轮回调（后续 LLM/工具调用共用）
      trace.setSession(sessionId);
      const callbacks = trace.callbacks();
      const messageId = `msg_${Date.now()}`;
      this.emit(res, 'start', { messageId });
      this.emit(res, 'data-session', { sessionId });

      // 2. 短期记忆窗口（Redis → miss 回填 PG，图3 第1步）+ user 消息落库
      const { messages: history, summary } = await this.memoryCache.loadWindow(
        userId,
        sessionId,
      );
      await this.sessions.appendMessage(
        sessionId,
        userId,
        'user',
        params.content,
      );
      const userEvicted = await this.memoryCache.writeBack(userId, sessionId, {
        role: 'user',
        content: params.content,
      });

      // 引用登记闭包（前置管线与工具共用，finalSources 统一编号）
      const sources: AiSourceDraft[] = [];

      // 3. 阶段1 意图路由 Planner（11 号工单：五类意图 + 建议检索词 + 工具门控；降级默认挂知识库）
      this.emit(res, 'data-status', { stage: 'plan', text: '识别意图...' });
      const plan = await this.planIntent(params.content, history);
      this.emit(res, 'data-plan', {
        intent: plan.intent,
        suggestedTerms: plan.suggestedTerms,
      });
      const intentLabel = INTENT_LABELS[plan.intent];
      const focus =
        plan.suggestedTerms.length > 0
          ? plan.suggestedTerms.join(' ')
          : plan.rewrittenQuery !== params.content
            ? plan.rewrittenQuery
            : '';
      this.emit(res, 'data-status', {
        stage: 'plan',
        text: focus
          ? `意图：${intentLabel} · 聚焦查询：${focus}`
          : `意图：${intentLabel}`,
      });

      // 4. 并行检索：KB RAG（意图挂知识库 且 needRetrieve 且非寒暄，用改写后 query）+ Mem0（始终，用原问题）
      const intentAllowsKb =
        plan.intent === 'knowledge' || plan.intent === 'knowledge_then_web';
      const shouldRetrieveKb =
        intentAllowsKb && plan.needRetrieve && !plan.isChitchat;
      if (this.mem0.available)
        this.emit(res, 'data-status', {
          stage: 'memory',
          text: '回忆相关记忆...',
        });
      const [kbHit, memHits] = await Promise.all([
        shouldRetrieveKb
          ? this.pipelineKbSearch(
            res,
            plan.rewrittenQuery,
            params.content,
            sources,
            scope,
          )
          : Promise.resolve({ items: [], text: '' }),
        this.mem0.search(params.content, userId, sessionId),
      ]);
      if (kbHit.items.length > 0)
        this.emit(res, 'data-retrieve', {
          query: plan.rewrittenQuery,
          items: kbHit.items,
        });
      if (memHits.length > 0) {
        this.emit(res, 'data-memory', {
          memories: memHits.map((m) => ({ layer: m.layer, text: m.text })),
        });
      }

      // 5. 工具（11 号工单：retrieve_knowledge 检索+评估捆绑 / rewrite_query 环内改写 / web_search；12 号：retrieve_graph 图谱补充检索；意图门控 + 预算计数）
      const retrieveTool = this.makeRetrieveTool(
        res,
        sources,
        params.content,
        scope,
      );
      const rewriteTool = this.makeRewriteTool(res);
      const webTool = this.makeWebTool(sources);
      const graphTool = this.makeGraphTool(res, sources);
      const allTools = [retrieveTool, rewriteTool, webTool, graphTool];
      const intentToolNames = new Set<string>(this.toolsForIntent(plan.intent));
      const budget = { total: 0, rewrite: 0, web: 0, graph: 0 };
      const allowed = (name: string): boolean => {
        if (!intentToolNames.has(name)) return false;
        if (budget.total >= MAX_TOOL_CALLS) return false;
        if (name === 'rewrite_query' && budget.rewrite >= MAX_REWRITE_CALLS)
          return false;
        if (name === 'web_search' && budget.web >= MAX_WEB_CALLS) return false;
        if (name === 'retrieve_graph' && budget.graph >= MAX_GRAPH_CALLS)
          return false;
        return true;
      };

      // 6. 手写 tool-calling 循环（v2 事件）；每轮按意图门控 + 剩余预算动态绑定工具（11 号工单）
      const baseModel = this.buildModel(params);
      const messages: Array<
        SystemMessage | HumanMessage | AIMessage | ToolMessage
      > = [
          new SystemMessage(
            this.buildSystemContext(memHits, summary, kbHit.text),
          ),
          ...history.map((h) =>
            h.role === 'user'
              ? new HumanMessage(h.content)
              : new AIMessage(h.content),
          ),
          new HumanMessage(params.content),
        ];

      let answer = '';
      let textSeq = 0;
      let reasoningSeq = 0;

      for (let step = 1; step <= MAX_ITERATIONS && !aborted; step++) {
        this.emit(res, 'start-step', { step });
        const runtimeTools = allTools.filter((t) => allowed(t.name));
        const stream = await (
          runtimeTools.length > 0
            ? baseModel.bindTools(runtimeTools)
            : baseModel
        ).stream(messages);
        let content = '';
        let textOpened = false;
        let reasoningOpened = false;
        const toolCalls = new Map<
          number,
          { id: string; name: string; args: string }
        >();

        for await (const chunk of stream) {
          if (aborted) break;
          // reasoning 思考流（qwen thinking：reasoning_content 在 additional_kwargs 或顶层）
          const reasoning = this.extractReasoning(chunk);
          if (reasoning) {
            if (!reasoningOpened) {
              reasoningSeq += 1;
              this.emit(res, 'reasoning-start', {
                id: `reasoning_${reasoningSeq}`,
              });
              reasoningOpened = true;
            }
            this.emit(res, 'reasoning-delta', {
              id: `reasoning_${reasoningSeq}`,
              delta: reasoning,
            });
          }
          const delta = typeof chunk.content === 'string' ? chunk.content : '';
          if (delta) {
            if (!textOpened) {
              textSeq += 1;
              this.emit(res, 'text-start', { id: `text_${textSeq}` });
              textOpened = true;
            }
            content += delta;
            this.emit(res, 'text-delta', { id: `text_${textSeq}`, delta });
          }
          for (const tc of chunk.tool_call_chunks ?? []) {
            const cur = toolCalls.get(tc.index ?? 0) ?? {
              id: '',
              name: '',
              args: '',
            };
            cur.id = tc.id ?? cur.id;
            cur.name = tc.name ?? cur.name;
            cur.args += tc.args ?? '';
            toolCalls.set(tc.index ?? 0, cur);
          }
        }
        if (reasoningOpened)
          this.emit(res, 'reasoning-end', { id: `reasoning_${reasoningSeq}` });
        if (textOpened) this.emit(res, 'text-end', { id: `text_${textSeq}` });
        answer += content;

        // 无工具调用 → 最终回答，结束循环
        if (toolCalls.size === 0) {
          messages.push(new AIMessage(content));
          break;
        }

        // 有工具调用：回填 AIMessage(tool_calls) 并逐个执行
        const aiWithTools = new AIMessage({
          content: content || '',
          tool_calls: [...toolCalls.values()].map((tc) => ({
            id: tc.id || `call_${tc.name}`,
            name: tc.name,
            args: this.safeParseArgs(tc.args),
          })),
        });
        messages.push(aiWithTools);

        let deniedCount = 0;
        for (const tc of aiWithTools.tool_calls ?? []) {
          if (aborted) break;
          const rawQuery = (tc.args as Record<string, unknown>)?.query;
          const query = typeof rawQuery === 'string' ? rawQuery : '';
          const name = tc.name;

          // 预算/门控拦截（11 号工单：代码强制；仍回 ToolMessage 保证 tool_calls 配对）
          if (!allowed(name)) {
            deniedCount += 1;
            messages.push(
              new ToolMessage({
                tool_call_id: tc.id ?? `call_${name}`,
                content: `工具 ${name} 本轮不可用（意图门控或预算：最多 ${MAX_TOOL_CALLS} 次工具调用，各类工具每轮 ${MAX_REWRITE_CALLS} 次）。请立即基于已有信息回答。`,
              }),
            );
            continue;
          }
          budget.total += 1;
          if (name === 'rewrite_query') budget.rewrite += 1;
          if (name === 'web_search') budget.web += 1;
          if (name === 'retrieve_graph') budget.graph += 1;

          if (name === 'retrieve_knowledge') {
            this.emit(res, 'data-status', {
              stage: 'retrieve',
              text: '正在检索知识库...',
            });
          } else if (name === 'web_search') {
            this.emit(res, 'data-status', {
              stage: 'web',
              text: '正在搜索网页...',
            });
          } else if (name === 'retrieve_graph') {
            this.emit(res, 'data-status', {
              stage: 'graph',
              text: '正在检索知识图谱...',
            });
          }
          try {
            // 按具体工具分支调用（四工具 schema 不同，避免联合类型 invoke 签名不兼容）
            type ToolOut = {
              summary: string;
              content: string;
              items?: Array<{
                documentId: string;
                documentTitle: string;
                excerpt: string;
              }>;
              results?: Array<{ title: string; url: string }>;
              entities?: Array<{
                name: string;
                type: string;
                description?: string;
              }>;
              relations?: Array<{
                source: string;
                relation: string;
                target: string;
              }>;
              /** 12 号：图谱服务降级时置位，外层跳过 data-graph 下发 */
              degraded?: boolean;
            };
            /* eslint-disable @typescript-eslint/no-unnecessary-type-assertion -- tsc 需要入参断言：StructuredToolCallInput 不接受 Record<string, any> */
            let out: ToolOut;
            // 工单 13：工具调用挂回调，生成 tool 观察（输入输出可追溯）
            if (name === 'retrieve_knowledge') {
              out = (await retrieveTool.invoke(tc.args as { query: string }, {
                callbacks,
              })) as ToolOut;
            } else if (name === 'rewrite_query') {
              out = (await rewriteTool.invoke(
                tc.args as { reason: string; terms: string[] },
                { callbacks },
              )) as ToolOut;
            } else if (name === 'web_search') {
              out = (await webTool.invoke(tc.args as { query: string }, {
                callbacks,
              })) as ToolOut;
            } else if (name === 'retrieve_graph') {
              out = (await graphTool.invoke(tc.args as { query: string }, {
                callbacks,
              })) as ToolOut;
            } else {
              out = {
                summary: '工具不可用',
                content: `工具 ${name} 不可用，请基于已有信息回答。`,
              };
            }
            /* eslint-enable @typescript-eslint/no-unnecessary-type-assertion */
            if (name === 'retrieve_knowledge') {
              // 过程展示用：同一文档多 chunk 去重，避免内联列表重复标题（仅展示切题子集）
              const seenDoc = new Set<string>();
              const items = (out.items ?? []).filter((it) => {
                if (seenDoc.has(it.documentId)) return false;
                seenDoc.add(it.documentId);
                return true;
              });
              this.emit(res, 'data-retrieve', { query, items });
            } else if (name === 'web_search') {
              this.emit(res, 'data-web-search', {
                query,
                results: out.results ?? [],
              });
            } else if (name === 'retrieve_graph') {
              // 降级（服务不可用）不下发事件，前端时间线不出现图谱卡
              if (!out.degraded) {
                this.emit(res, 'data-graph', {
                  query,
                  entities: out.entities ?? [],
                  relations: out.relations ?? [],
                });
              }
            }
            messages.push(
              new ToolMessage({
                tool_call_id: tc.id ?? `call_${name}`,
                content: out.content,
              }),
            );
          } catch (err) {
            this.logger.warn(
              `工具 ${name} 执行异常: ${err instanceof Error ? err.message : err}`,
            );
            const msg = `工具 ${name} 执行失败，请基于已有信息回答并向用户说明。`;
            if (name === 'retrieve_knowledge') {
              this.emit(res, 'data-retrieve', { query, items: [] });
            } else if (name === 'web_search') {
              this.emit(res, 'data-web-search', { query, results: [] });
            } else if (name === 'retrieve_graph') {
              this.emit(res, 'data-graph', {
                query,
                entities: [],
                relations: [],
              });
            }
            messages.push(
              new ToolMessage({
                tool_call_id: tc.id ?? `call_${name}`,
                content: msg,
              }),
            );
          }
        }
        // 本轮工具调用全部被意图门控/预算拦截 → 强制退出循环进入生成
        const callCount = aiWithTools.tool_calls?.length ?? 0;
        if (callCount > 0 && deniedCount === callCount) break;
      }

      if (aborted) {
        this.logger.log(
          `AI 对话客户端断连 userId=${userId} 已生成 ${answer.length} 字（已落库）`,
        );
      }

      // 5. 引用过滤（11 号工单阶段6：只下发被 [n] 引用的来源；无标记回退全量）→ data-sources
      const finalSources = this.filterCitedSources(answer, sources);
      this.emit(res, 'data-sources', { sources: finalSources });

      // 6. suggestions（非流式快速生成，失败兜底固定池）→ finish
      const suggestions = await this.generateSuggestions(messages).catch(
        () => FALLBACK_SUGGESTIONS,
      );
      // 工单 13：附带 traceId（tracing 未启用时为 undefined，JSON 序列化时自动省略），供评测/前端关联
      this.emit(res, 'finish', {
        messageId,
        suggestions,
        traceId: trace.traceId(),
      });

      // 7. 持久化 assistant 消息（断连时也落库已生成部分）+ 记忆管线收尾（图3 第5/6步）
      const finalAnswer = answer || '（本次回答未生成内容）';
      // 工单 13：登记 trace 最终输出（回答正文 + 引用条数）
      trace.finish({ answer: finalAnswer, sources: finalSources.length });
      await this.sessions.appendMessage(
        sessionId,
        userId,
        'assistant',
        finalAnswer,
        finalSources,
      );
      const evicted = await this.memoryCache.writeBack(userId, sessionId, {
        role: 'assistant',
        content: finalAnswer,
      });
      // 异步任务不阻塞响应：溢出增量摘要 + Mem0 事实分类写入（内部全降级）
      void this.memoryCache.summarizeOverflow(userId, sessionId, [
        ...userEvicted,
        ...evicted,
      ]);
      void this.ingestMem0(userId, sessionId, params.content, finalAnswer);
      this.logger.log(
        `AI 对话完成 userId=${userId} session=${sessionId} answerLen=${answer.length} sources=${finalSources.length}`,
      );
    } catch (err) {
      // 顶层兜底：任何未预期异常都降级为 error + finish，不抛 500
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(`AI 对话失败 userId=${userId}: ${msg}`);
      // 工单 13：失败也登记 trace 输出并标 ERROR，便于在 Langfuse 中筛出失败会话
      trace.finish({ answer: '', sources: 0 }, msg);
      this.emit(res, 'error', { message: 'AI 服务繁忙，请稍后重试' });
      this.emit(res, 'finish', {
        messageId: `msg_${Date.now()}`,
        suggestions: FALLBACK_SUGGESTIONS,
        traceId: trace.traceId(),
      });
    } finally {
      res.end();
    }
  }

  /** 按请求参数构建模型（enableThinking → qwen-plus-latest + enable_thinking 透传） */
  private buildModel(params: AiChatStreamParams): ChatOpenAI {
    const thinking = params.enableThinking === true;
    const base = {
      openAIApiKey: this.config.get<string>('OPENAI_API_KEY'),
      temperature: thinking ? undefined : (params.temperature ?? 0.3),
      configuration: { baseURL: this.config.get<string>('EMBEDDING_BASE_URL') },
      // 工单 13：构造器级回调，本轮所有模型调用（含多步 Agent 循环）自动进同一 trace
      callbacks: this.tracing.current(),
    };
    const modelName = thinking
      ? 'qwen-plus-latest'
      : (params.model ?? this.config.get<string>('LLM_MODEL', 'qwen-plus'));
    // dashscope compatible-mode：thinking 经 modelKwargs 合入请求体顶层 enable_thinking（LangChain 无 extraBody 字段；thinking 模式下 temperature 不生效，不传）
    const ctorArgs = thinking
      ? { ...base, modelName, modelKwargs: { enable_thinking: true } }
      : { ...base, modelName };
    return new ChatOpenAI(ctorArgs as never);
  }

  /**
   * 阶段1 意图路由 Planner（11 号工单）——一次轻量 LLM 调用完成五类意图分类、
   * 指代改写与建议检索词提炼；结果经 data-plan 下发并决定本轮工具门控。
   * 降级：解析失败/超时 → knowledge + 原问题 + needRetrieve=true（默认挂知识库检索）。
   */
  private async planIntent(
    question: string,
    history: Array<{ role: string; content: string }>,
  ): Promise<PlanResult> {
    const fallback: PlanResult = {
      intent: 'knowledge',
      rewrittenQuery: question,
      suggestedTerms: [],
      needRetrieve: true,
      isChitchat: false,
    };
    try {
      const model = this.buildUtilityModel(300, 5000);
      const recent =
        history
          .slice(-6)
          .map(
            (h) =>
              `${h.role === 'user' ? '用户' : '助手'}：${h.content.slice(0, 200)}`,
          )
          .join('\n') || '（无）';
      const resp = await model.invoke([
        new SystemMessage(`你是意图路由与查询理解模块。结合最近对话判断当前问题，只输出 JSON：
{"intent":"chitchat|preference|knowledge|web|knowledge_then_web","rewritten_query":"...","suggested_terms":["词1","词2"],"needRetrieve":true/false,"isChitchat":true/false}
五类意图：
- chitchat 闲聊：寒暄/问候/无任务意图（不挂检索）
- preference 个人偏好：询问或表达对回答风格、格式等个人偏好（不挂检索）
- knowledge 知识库：企业制度/文档/流程等内部知识（挂知识库）
- web 联网：明确的公网/时效性问题（挂联网）
- knowledge_then_web 知识库不足再联网：优先查知识库、不够时再联网（两套都挂）
规则：
- rewritten_query：问题含指代（如"那这个谁负责"）时结合最近对话改写为独立完整的检索查询；否则=原问题
- suggested_terms：从问题提炼 2-4 个检索关键词（如"加班 餐补 制度"），闲聊可为 []
- 寒暄/闲聊：intent=chitchat，needRetrieve=false，isChitchat=true
- 通用常识、无需查企业知识库的问题：needRetrieve=false
- 其余：needRetrieve=true。只输出 JSON，不要输出其他内容`),
        new HumanMessage(`最近对话：\n${recent}\n\n当前问题：${question}`),
      ]);
      const raw = typeof resp.content === 'string' ? resp.content : '';
      const match = raw.match(/\{[\s\S]*\}/);
      if (!match) throw new Error('意图路由解析失败');
      const parsed = JSON.parse(match[0]) as {
        intent?: unknown;
        rewritten_query?: unknown;
        suggested_terms?: unknown;
        needRetrieve?: unknown;
        isChitchat?: unknown;
      };
      const rawIntent = typeof parsed.intent === 'string' ? parsed.intent : '';
      const intent = (
        VALID_INTENTS.has(rawIntent) ? rawIntent : 'knowledge'
      ) as AgentIntent;
      return {
        intent,
        rewrittenQuery:
          typeof parsed.rewritten_query === 'string' &&
            parsed.rewritten_query.trim()
            ? parsed.rewritten_query.trim()
            : question,
        suggestedTerms: Array.isArray(parsed.suggested_terms)
          ? parsed.suggested_terms
            .filter(
              (s): s is string =>
                typeof s === 'string' && s.trim().length > 0,
            )
            .map((s) => s.trim())
            .slice(0, 6)
          : [],
        needRetrieve: parsed.needRetrieve !== false,
        isChitchat: parsed.isChitchat === true || intent === 'chitchat',
      };
    } catch (err) {
      this.logger.warn(
        `意图路由降级(按知识库检索): ${err instanceof Error ? err.message : err}`,
      );
      return fallback;
    }
  }

  /** 阶段1 工具门控（11 号工单；12 号：kb 类意图补挂 retrieve_graph）——按五类意图决定本轮可用工具集 */
  private toolsForIntent(intent: AgentIntent): string[] {
    switch (intent) {
      case 'chitchat':
      case 'preference':
        return [];
      case 'knowledge':
        return ['retrieve_knowledge', 'retrieve_graph', 'rewrite_query'];
      case 'web':
        return ['web_search', 'rewrite_query'];
      case 'knowledge_then_web':
        return [
          'retrieve_knowledge',
          'retrieve_graph',
          'rewrite_query',
          'web_search',
        ];
    }
  }

  /**
   * 阶段3 切题评估 Grader（11 号工单）——逐条评估资料与问题是否同一主题（四态）。
   * 返回 null = 评估降级，调用方按全量可用处理（可用性优先）；off_topic 不进上下文与引用池。
   */
  private async gradeChunks(
    question: string,
    chunks: Array<{ title: string; content: string }>,
  ): Promise<ChunkGrade[] | null> {
    if (chunks.length === 0) return [];
    try {
      const model = this.buildUtilityModel(500, 5000);
      const list = chunks
        .map((c, i) => `[${i}] ${c.title}\n${c.content.slice(0, 300)}`)
        .join('\n\n');
      const resp = await model.invoke([
        new SystemMessage(`你是切题评估模块。判断每条资料与问题是否同一主题，只输出 JSON：{"grades":[{"index":0,"grade":"on_topic"}]}
grade 取值：
- on_topic 切题：与问题同一主题，可作为回答依据
- partial 部分相关：沾边但信息可能不足
- off_topic 不切题：与问题无关，不能当制度依据
对每条资料的 index 都输出一个 grade。只输出 JSON，不要输出其他内容。`),
        new HumanMessage(`问题：${question}\n\n资料：\n${list}`),
      ]);
      const raw = typeof resp.content === 'string' ? resp.content : '';
      const match = raw.match(/\{[\s\S]*\}/);
      if (!match) throw new Error('切题评估解析失败');
      const parsed = JSON.parse(match[0]) as {
        grades?: Array<{ index?: unknown; grade?: unknown }>;
      };
      const map = new Map<number, ChunkGrade>();
      for (const g of Array.isArray(parsed.grades) ? parsed.grades : []) {
        const idx = Number(g.index);
        const grade = typeof g.grade === 'string' ? g.grade : '';
        if (
          VALID_GRADES.has(grade) &&
          Number.isInteger(idx) &&
          idx >= 0 &&
          idx < chunks.length
        ) {
          map.set(idx, grade as ChunkGrade);
        }
      }
      // 未覆盖的条目按 partial（进上下文但视为信息可能不足）
      return chunks.map((_, i) => map.get(i) ?? 'partial');
    } catch (err) {
      this.logger.warn(
        `切题评估降级(全量可用): ${err instanceof Error ? err.message : err}`,
      );
      return null;
    }
  }

  /** 汇总整体评估态：无资料→none；评估降级→on_topic；全不切题→off_topic；有切题→on_topic；否则 partial */
  private overallGrade(
    grades: ChunkGrade[] | null,
    count: number,
  ): 'none' | ChunkGrade {
    if (count === 0) return 'none';
    if (grades === null) return 'on_topic';
    if (grades.every((g) => g === 'off_topic')) return 'off_topic';
    if (grades.some((g) => g === 'on_topic')) return 'on_topic';
    return 'partial';
  }

  /** 评估态中文文案（对齐原图四态） */
  private gradeLabel(grade: 'none' | ChunkGrade): string {
    switch (grade) {
      case 'on_topic':
        return '切题';
      case 'partial':
        return '部分相关';
      case 'off_topic':
        return '不切题';
      default:
        return '无结果';
    }
  }

  /**
   * 引用登记（11 号工单阶段6）：返回全局编号 [n]，与最终 sources 序号一致；
   * knowledge 按 doc_id 去重、web 按 url 去重，重复登记返回既有编号。
   */
  private registerSource(
    sources: AiSourceDraft[],
    draft: AiSourceDraft,
  ): number {
    const key = draft.ref ?? draft.url ?? '';
    if (key) {
      const idx = sources.findIndex(
        (s) => s.kind === draft.kind && (s.ref ?? s.url ?? '') === key,
      );
      if (idx >= 0) return idx + 1;
    }
    sources.push(draft);
    return sources.length;
  }

  /**
   * 引用过滤（11 号工单阶段6）：解析最终文本的 [n]（知识库）与 [Wk]/(来源: 域名)（Web），
   * 只保留真正被引用的来源；无任何标记或过滤结果为空时回退全量（现状兜底）。
   */
  private filterCitedSources(
    answer: string,
    drafts: AiSourceDraft[],
  ): Array<AiSource & { index: number }> {
    const all = drafts.map((s, i) => ({ index: i + 1, ...s }));
    if (all.length === 0 || !answer) return all;
    const numeric = new Set<number>();
    for (const m of answer.matchAll(/\[(\d{1,3})\]/g))
      numeric.add(Number(m[1]));
    const wNums = new Set<number>();
    for (const m of answer.matchAll(/\[W(\d{1,2})\]/gi))
      wNums.add(Number(m[1]));
    const hasDomainHint = /\(来源[:：]/.test(answer);
    // web 的局部序号 Wk → 全局 index（按登记顺序）
    const webLocalToGlobal = new Map<number, number>();
    let w = 0;
    for (const s of all) {
      if (s.kind === 'web') {
        w += 1;
        webLocalToGlobal.set(w, s.index);
      }
    }
    const kept = all.filter((s) => {
      if (s.kind === 'web') {
        for (const [local, idx] of webLocalToGlobal) {
          if (idx === s.index && wNums.has(local)) return true;
        }
        if (
          (hasDomainHint || wNums.size > 0) &&
          s.url &&
          answer.includes(this.safeDomain(s.url))
        )
          return true;
        return false;
      }
      // knowledge / graph（12 号：图谱来源同样按 [n] 全局编号引用）均按数字标记过滤
      return numeric.has(s.index);
    });
    const hasAnyMarker = numeric.size > 0 || wNums.size > 0 || hasDomainHint;
    if (!hasAnyMarker || kept.length === 0) return all;
    return kept;
  }

  /**
   * 前置管线 KB 检索（阶段2+3：混合检索 + 切题评估）：与 retrieve_knowledge 共用引用登记
   * （全局 [n] 编号），off_topic 剔除不进上下文；异常静默降级为空，评估失败全量可用。
   */
  private async pipelineKbSearch(
    res: Response,
    query: string,
    question: string,
    sources: AiSourceDraft[],
    scope?: VisibilityScope,
  ): Promise<{
    items: Array<{
      documentId: string;
      documentTitle: string;
      excerpt: string;
      /** 完整 chunk 正文（excerpt 仅 120 字供前端卡片显示；评测/详情需要全文） */
      content: string;
    }>;
    text: string;
  }> {
    try {
      const { items } = await this.ragSearch.search(query, 5, true, scope);
      if (items.length === 0) return { items: [], text: '' };
      this.emit(res, 'data-status', { stage: 'grade', text: '评估资料...' });
      const grades = await this.gradeChunks(
        question,
        items.map((it) => ({ title: it.doc_title, content: it.content })),
      );
      const kept = items.filter(
        (_, i) => grades === null || grades[i] !== 'off_topic',
      );
      const dropped = items.length - kept.length;
      this.emit(res, 'data-status', {
        stage: 'grade',
        text:
          grades === null
            ? '切题评估降级，资料全量可用'
            : dropped > 0
              ? `切题评估完成：可用 ${kept.length} 条 · 剔除不切题 ${dropped} 条`
              : `切题评估完成：${kept.length} 条均切题`,
      });
      if (kept.length === 0) return { items: [], text: '' };
      const outItems: Array<{
        documentId: string;
        documentTitle: string;
        excerpt: string;
        content: string;
      }> = [];
      const lines: string[] = [];
      for (const it of kept) {
        const n = this.registerSource(sources, {
          kind: 'knowledge',
          title: it.doc_title,
          ref: it.doc_id,
          excerpt: it.content.slice(0, EXCERPT_LEN),
          heading: null,
        });
        outItems.push({
          documentId: it.doc_id,
          documentTitle: it.doc_title,
          excerpt: it.content.slice(0, EXCERPT_LEN),
          content: it.content,
        });
        lines.push(`[${n}] ${it.doc_title}\n${it.content.slice(0, 500)}`);
      }
      return { items: outItems, text: lines.join('\n\n') };
    } catch (err) {
      this.logger.warn(
        `前置 KB 检索降级: ${err instanceof Error ? err.message : err}`,
      );
      return { items: [], text: '' };
    }
  }

  /** 上下文组合（图3 第4步）：人设 → 记忆 → 摘要 → 检索资料，全部并入 system */
  private buildSystemContext(
    memHits: Mem0Hit[],
    summary: string,
    kbText: string,
  ): string {
    const sections: string[] = [SYSTEM_PROMPT];
    if (memHits.length > 0) {
      const userMem = memHits.filter((m) => m.layer === 'user');
      const sessionMem = memHits.filter((m) => m.layer === 'session');
      if (userMem.length > 0) {
        sections.push(
          `【用户长期记忆】\n${userMem.map((m) => `- ${m.text}`).join('\n')}`,
        );
      }
      if (sessionMem.length > 0) {
        sections.push(
          `【当前会话记忆】\n${sessionMem.map((m) => `- ${m.text}`).join('\n')}`,
        );
      }
    }
    if (summary) sections.push(`【早期对话摘要】\n${summary}`);
    if (kbText) sections.push(`【知识库检索资料】\n${kbText}`);
    return sections.join('\n\n');
  }

  /**
   * Mem0 事实分类写入（图3 第6步，异步不阻塞）：单次 LLM 调用分类+抽取一体，
   * 用户层事实（不带 run_id）与会话层事实（带 run_id）分组写入；失败仅记日志。
   */
  private async ingestMem0(
    userId: string,
    sessionId: string,
    question: string,
    answer: string,
  ): Promise<void> {
    if (!this.mem0.available) return;
    try {
      const model = this.buildUtilityModel(300, 10000);
      const resp = await model.invoke([
        new SystemMessage(`你是记忆抽取分类器。判断这轮问答是否包含值得记住的「用户事实」，只输出 JSON：{"facts":[{"text":"简体中文短句","layer":"user"或"session"}]}
- layer=user：跨会话有效的用户身份/岗位/团队/回答偏好/长期约束
- layer=session：仅本会话有效的任务/进度/待办
- 不写入：寒暄闲聊；文档、知识库或网络搜索中提到的知识（制度、负责人等，不能当用户画像）；无新事实时 facts=[]
- text 必须是简体中文短句（抽取的事实，不是聊天原文）`),
        new HumanMessage(`用户：${question}\n助手：${answer.slice(0, 1000)}`),
      ]);
      const raw = typeof resp.content === 'string' ? resp.content : '';
      const match = raw.match(/\{[\s\S]*\}/);
      if (!match) return;
      const parsed = JSON.parse(match[0]) as {
        facts?: Array<{ text?: unknown; layer?: unknown }>;
      };
      const facts = (parsed.facts ?? []).filter(
        (f): f is { text: string; layer: string } =>
          typeof f.text === 'string' && f.text.trim().length > 0,
      );
      if (facts.length === 0) return;
      const toMsgs = (arr: typeof facts) =>
        arr.map((f) => ({ role: 'user', content: f.text.trim() }));
      const userFacts = toMsgs(facts.filter((f) => f.layer === 'user'));
      const sessionFacts = toMsgs(facts.filter((f) => f.layer !== 'user'));
      if (userFacts.length > 0) await this.mem0.add(userFacts, userId);
      if (sessionFacts.length > 0)
        await this.mem0.add(sessionFacts, userId, sessionId);
      this.logger.log(
        `Mem0 记忆写入 user=${userFacts.length} session=${sessionFacts.length}`,
      );
    } catch (err) {
      this.logger.warn(
        `Mem0 抽取/写入降级(本轮不写): ${err instanceof Error ? err.message : err}`,
      );
    }
  }

  /** 轻量工具模型（改写判断/摘要/记忆抽取共用）：MEMORY_LLM_MODEL 默认 qwen-turbo，快速失败 */
  private buildUtilityModel(maxTokens: number, timeoutMs: number): ChatOpenAI {
    return new ChatOpenAI({
      openAIApiKey: this.config.get<string>('OPENAI_API_KEY'),
      modelName: this.config.get<string>('MEMORY_LLM_MODEL', 'qwen-turbo'),
      temperature: 0.1,
      maxTokens,
      maxRetries: 0,
      configuration: {
        baseURL: this.config.get<string>('EMBEDDING_BASE_URL'),
        timeout: timeoutMs,
      },
      // 工单 13：意图路由 / 切题评估 / 记忆抽取共用轻量模型，同样进本轮 trace
      callbacks: this.tracing.current(),
    } as never);
  }

  /** 提取 thinking 增量（qwen 经 compatible-mode 返回 reasoning_content） */
  private extractReasoning(chunk: unknown): string {
    const c = chunk as {
      additional_kwargs?: { reasoning_content?: string };
      reasoning_content?: string;
      content?: unknown;
    };
    if (c?.additional_kwargs?.reasoning_content)
      return c.additional_kwargs.reasoning_content;
    if (typeof c?.reasoning_content === 'string') return c.reasoning_content;
    return '';
  }

  /**
   * 阶段2+3 捆绑工具 retrieve_knowledge（11 号工单）：混合检索（仅可见文档）+ 自动切题评估，
   * 返回评估结论与切题资料（全局 [n] 编号，与 data-sources 序号一致）；09 号工单 scope 过滤保留。
   */
  private makeRetrieveTool(
    res: Response,
    sources: AiSourceDraft[],
    question: string,
    scope?: VisibilityScope,
  ) {
    return tool(
      async ({ query }) => {
        try {
          const { items } = await this.ragSearch.search(query, 5, true, scope);
          if (items.length === 0) {
            return {
              summary: '知识库 0 条命中',
              content: '评估结论：无结果。知识库中未检索到相关内容。',
              grade: 'none',
              items: [] as Array<{
                documentId: string;
                documentTitle: string;
                excerpt: string;
              }>,
            };
          }
          this.emit(res, 'data-status', {
            stage: 'grade',
            text: '评估资料...',
          });
          const grades = await this.gradeChunks(
            question,
            items.map((it) => ({ title: it.doc_title, content: it.content })),
          );
          const kept = items.filter(
            (_, i) => grades === null || grades[i] !== 'off_topic',
          );
          const overall = this.overallGrade(grades, items.length);
          const dropped = items.length - kept.length;
          this.emit(res, 'data-status', {
            stage: 'grade',
            text: `切题评估：${this.gradeLabel(overall)}${dropped > 0 ? ` · 剔除不切题 ${dropped} 条` : ''}`,
          });
          if (kept.length === 0) {
            return {
              summary: `知识库 ${items.length} 条均不切题`,
              content: `评估结论：不切题。检索到的 ${items.length} 条资料与问题无关，不能作为依据。请用 rewrite_query 换检索词重试，或基于已有信息回答并向用户说明知识库无相关内容。`,
              grade: 'off_topic',
              items: [] as Array<{
                documentId: string;
                documentTitle: string;
                excerpt: string;
              }>,
            };
          }
          const outItems: Array<{
            documentId: string;
            documentTitle: string;
            excerpt: string;
            content: string;
          }> = [];
          const lines: string[] = [];
          for (const it of kept) {
            const n = this.registerSource(sources, {
              kind: 'knowledge',
              title: it.doc_title,
              ref: it.doc_id,
              excerpt: it.content.slice(0, EXCERPT_LEN),
              heading: null,
            });
            outItems.push({
              documentId: it.doc_id,
              documentTitle: it.doc_title,
              excerpt: it.content.slice(0, EXCERPT_LEN),
              content: it.content,
            });
            lines.push(`[${n}] ${it.doc_title}\n${it.content.slice(0, 500)}`);
          }
          const label = this.gradeLabel(overall);
          return {
            summary: `知识库命中 ${items.length} 条 · ${label}`,
            content: `评估结论：${label}（可用 ${kept.length}/${items.length} 条）\n\n${lines.join('\n\n')}`,
            grade: overall,
            items: outItems,
          };
        } catch (err) {
          this.logger.warn(
            `retrieve_knowledge 降级: ${err instanceof Error ? err.message : err}`,
          );
          return {
            summary: '知识库检索暂不可用',
            content:
              '知识库检索服务暂时不可用，请基于已有信息回答，并提示用户稍后重试检索。',
            grade: 'none',
            items: [] as Array<{
              documentId: string;
              documentTitle: string;
              excerpt: string;
            }>,
          };
        }
      },
      {
        name: 'retrieve_knowledge',
        description:
          '检索企业内部知识库并自动做切题评估（BM25+向量混合检索、仅当前用户可见文档），返回评估结论与按全局编号的切题资料；回答企业内部制度/文档/知识类问题时优先使用',
        schema: z.object({ query: z.string().describe('检索关键词或问题') }),
      },
    );
  }

  /**
   * 阶段4 环内改写工具 rewrite_query（11 号工单）：依据不足原因与新检索词换一种问法再查；
   * 是否改写、用什么词由模型自主决定，全轮最多 1 次（预算在循环中强制）。
   */
  private makeRewriteTool(res: Response) {
    return tool(
      ({ reason, terms }: { reason: string; terms: string[] }) => {
        const q = (terms ?? [])
          .map((t) => String(t).trim())
          .filter(Boolean)
          .join(' ');
        if (!q) {
          return {
            summary: '改写无效',
            content:
              '改写无效：未提供检索词。请基于原检索词继续，或直接基于已有信息回答。',
          };
        }
        this.emit(res, 'data-status', {
          stage: 'rewrite',
          text: `改写查询：${q}`,
        });
        return {
          summary: `已改写：${q}`,
          content: `已将检索词改写为：${q}（不足原因：${reason || '信息不足'}）。请立刻用该检索词调用 retrieve_knowledge 重新检索。`,
          query: q,
        };
      },
      {
        name: 'rewrite_query',
        description:
          '对检索词进行改写后重新检索（评估不足/无结果时使用，每轮最多 1 次）。是否改写、用什么词由你自主决定',
        schema: z.object({
          reason: z
            .string()
            .describe('不足原因（如：上次检索词没命中、只找到部分信息）'),
          terms: z.array(z.string()).describe('新的检索关键词列表（2-4 个词）'),
        }),
      },
    );
  }

  /** Web 搜索工具（Tavily，v2：返回 results 含 title/url；未配 key/超时/异常降级） */
  private makeWebTool(sources: AiSourceDraft[]) {
    const apiKey = this.config.get<string>('TAVILY_SEARCH');
    const available = !!apiKey;
    return tool(
      async ({ query }) => {
        if (!available) {
          return {
            summary: 'Web 搜索未配置',
            content:
              'Web 搜索能力未配置（缺少 TAVILY_SEARCH）。请告知用户当前仅能基于企业知识库回答，如需公网信息请管理员配置搜索服务。',
            results: [] as Array<{ title: string; url: string }>,
          };
        }
        try {
          const ctrl = new AbortController();
          const timer = setTimeout(() => ctrl.abort(), TAVILY_TIMEOUT_MS);
          const resp = await fetch('https://api.tavily.com/search', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              api_key: apiKey,
              query,
              max_results: 5,
              search_depth: 'basic',
            }),
            signal: ctrl.signal,
          });
          clearTimeout(timer);
          if (!resp.ok) throw new Error(`tavily ${resp.status}`);
          const data = (await resp.json()) as {
            results?: Array<{ title: string; url: string; content: string }>;
          };
          const results = (data.results ?? []).slice(0, 5);
          if (results.length === 0) {
            return {
              summary: 'Web 0 条命中',
              content: '公网搜索未找到相关结果。',
              results: [],
            };
          }
          for (const r of results) {
            const domain = this.safeDomain(r.url);
            sources.push({
              kind: 'web',
              title: `${r.title} — ${domain}`,
              url: r.url,
              excerpt: r.content.slice(0, EXCERPT_LEN),
              heading: null,
            });
          }
          const text = results
            .map(
              (r, i) =>
                `[W${i + 1}] ${r.title} (${this.safeDomain(r.url)})\n${r.content.slice(0, 300)}`,
            )
            .join('\n\n');
          return {
            summary: `Web 命中 ${results.length} 条`,
            content: text,
            results: results.map((r) => ({ title: r.title, url: r.url })),
          };
        } catch (err) {
          this.logger.warn(
            `web_search 降级: ${err instanceof Error ? err.message : err}`,
          );
          return {
            summary: 'Web 搜索暂不可用',
            content:
              '公网搜索服务暂时不可用，请基于已有信息回答，并告知用户 Web 结果缺失。',
            results: [],
          };
        }
      },
      {
        name: 'web_search',
        description:
          '搜索公网信息（时效性/外部知识），仅在知识库无法回答时使用',
        schema: z.object({ query: z.string().describe('搜索关键词') }),
      },
    );
  }

  /**
   * 图谱检索工具 retrieve_graph（12 号工单）：调 kgService.searchGraph 查实体关系子图，
   * 每条 RELATED_TO 三元组登记一条 kind='graph' 来源（参与全局 [n] 编号），并返回
   * entities/relations 供循环 emit data-graph；不过 Grader（子串精确命中噪音低，topK 截断直进）；
   * Neo4j 不可用/查询失败降级为提示文本，流不中断。
   */
  private makeGraphTool(res: Response, sources: AiSourceDraft[]) {
    return tool(
      async ({ query }) => {
        try {
          const { entities, edges } = await this.kg.searchGraph(
            query,
            undefined,
            GRAPH_ENTITY_LIMIT,
          );
          const ents = entities.slice(0, GRAPH_ENTITY_LIMIT).map((e) => ({
            name: e.name,
            type: e.type,
            description: e.description ?? undefined,
          }));
          const relations = edges.slice(0, GRAPH_RELATION_LIMIT).map((e) => ({
            source: e.sourceName,
            relation: e.relation,
            target: e.targetName,
          }));
          // 补齐关系两端但未命中实体列表的实体（保证前端 mini 力导图节点着色完整）
          for (const e of edges.slice(0, GRAPH_RELATION_LIMIT)) {
            if (!ents.some((x) => x.name === e.sourceName)) {
              ents.push({
                name: e.sourceName,
                type: e.sourceType,
                description: undefined,
              });
            }
            if (!ents.some((x) => x.name === e.targetName)) {
              ents.push({
                name: e.targetName,
                type: e.targetType,
                description: undefined,
              });
            }
          }
          if (relations.length === 0) {
            return {
              summary: `图谱 0 条命中（实体 ${ents.length}）`,
              content:
                '知识图谱中未检索到与该主题相关的实体关系，请改用 retrieve_knowledge 检索文档资料。',
              entities: ents,
              relations: [] as Array<{
                source: string;
                relation: string;
                target: string;
              }>,
            };
          }
          // 每条关系三元组登记一条 graph 来源（ref 去重），与文档 chunk 粒度对齐
          const lines: string[] = [];
          for (const r of relations) {
            const src = ents.find((e) => e.name === r.source);
            const tgt = ents.find((e) => e.name === r.target);
            const n = this.registerSource(sources, {
              kind: 'graph',
              title: `${r.source} —${r.relation}→ ${r.target}`,
              ref: `graph:${r.source}->${r.relation}->${r.target}`,
              excerpt:
                (src?.description ?? tgt?.description ?? '').slice(
                  0,
                  EXCERPT_LEN,
                ) || undefined,
              heading: null,
            });
            lines.push(
              `[${n}] 图谱关系：${r.source}（${src?.type ?? 'unknown'}）—${r.relation}→ ${r.target}（${tgt?.type ?? 'unknown'}）`,
            );
          }
          const entText = ents
            .map(
              (e) =>
                `${e.name}（${e.type}${e.description ? `：${e.description}` : ''}）`,
            )
            .join('；');
          return {
            summary: `图谱命中 实体 ${ents.length} / 关系 ${relations.length}`,
            content: `知识图谱实体关系（描述实体间审批/归属/关联等事实，可作回答依据并标 [n]）：\n\n${lines.join('\n')}\n\n相关实体：${entText}`,
            entities: ents,
            relations,
          };
        } catch (err) {
          this.logger.warn(
            `retrieve_graph 降级: ${err instanceof Error ? err.message : err}`,
          );
          return {
            summary: '知识图谱暂不可用',
            content:
              '知识图谱服务暂时不可用，请仅依据文档资料回答，不要编造实体关系。',
            entities: [] as Array<{
              name: string;
              type: string;
              description?: string;
            }>,
            relations: [] as Array<{
              source: string;
              relation: string;
              target: string;
            }>,
            degraded: true,
          };
        }
      },
      {
        name: 'retrieve_graph',
        description:
          '检索企业知识图谱中的实体关系子图（人/组织/技术/术语等实体及其关联），适合回答「实体之间的关系、谁审批、谁归属哪个流程」类问题；作为文档检索的补充',
        schema: z.object({ query: z.string().describe('实体名或关系关键词') }),
      },
    );
  }

  /** 基于最终 messages 生成 6 条推荐追问（非流式，失败由调用方兜底固定池） */
  private async generateSuggestions(
    messages: Array<SystemMessage | HumanMessage | AIMessage | ToolMessage>,
  ): Promise<string[]> {
    const suggestionModel = new ChatOpenAI({
      openAIApiKey: this.config.get<string>('OPENAI_API_KEY'),
      modelName: this.config.get<string>('LLM_MODEL', 'qwen-plus'),
      temperature: 0.8,
      maxTokens: 300,
      configuration: { baseURL: this.config.get<string>('EMBEDDING_BASE_URL') },
      // 工单 13：推荐追问生成同样进本轮 trace
      callbacks: this.tracing.current(),
    });
    const resp = await suggestionModel.invoke([
      new SystemMessage(
        '根据对话内容，生成用户最可能继续追问的 6 个问题。只输出 JSON 数组，每项一个短句（15 字内），不要输出其他内容。',
      ),
      ...messages.slice(-4),
      new HumanMessage('请生成 6 条推荐追问。'),
    ]);
    const raw = typeof resp.content === 'string' ? resp.content : '';
    const match = raw.match(/\[[\s\S]*\]/);
    if (!match) throw new Error('suggestions 解析失败');
    const parsed = JSON.parse(match[0]) as unknown;
    if (!Array.isArray(parsed) || parsed.length === 0)
      throw new Error('suggestions 为空');
    return parsed.filter((s): s is string => typeof s === 'string').slice(0, 6);
  }

  private safeParseArgs(args: string): Record<string, unknown> {
    try {
      return args ? (JSON.parse(args) as Record<string, unknown>) : {};
    } catch {
      return { query: args };
    }
  }

  private safeDomain(url: string): string {
    try {
      return new URL(url).hostname;
    } catch {
      return url.slice(0, 40);
    }
  }

  private writeSseHeaders(res: Response): void {
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();
  }

  /** v2 单通道事件：`data: {"type":"...","data":{...}}\n\n`（对齐 AI SDK UIMessage Stream Protocol） */
  private emit(
    res: Response,
    type: AiStreamEvent,
    data: Record<string, unknown>,
  ): void {
    res.write(`data: ${JSON.stringify({ type, data })}\n\n`);
  }
}
