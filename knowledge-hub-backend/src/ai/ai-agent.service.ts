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
// 工单 23：工具实现下沉到 ./tools/，service 只保留 tool() 注册与 deps 装配
import { retrieveKnowledge } from './tools/retrieve-knowledge';
import { rewriteQuery } from './tools/rewrite-query';
import { webSearch } from './tools/web-search';
import { retrieveGraph } from './tools/retrieve-graph';
import { createSourceRegistry } from './tools/source-registry';
import { safeDomain } from './tools/utils';
import { EXCERPT_LEN } from './tools/constants';
import type { ToolDeps } from './tools/types';
import { buildToolDenial, TOOL_BUDGET_LIMITS } from './tool-denial';
import {
  CitationStreamFilter,
  findInvalidCitations,
  stripCitationMarkers,
} from './citation';
import { shouldForceRetrieve } from './force-retrieve';
// 生成式 UI：Agent 输出界面蓝图（详见 docs/engineering/genui-surface.md）
import { CATALOG } from './ui/catalog';
import { validateSurface, type Surface } from './ui/surface';
import { buildKnowledgeSurface } from './ui/builders/knowledge';

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
  /** 生成式 UI：surface 骨架（与 data-* 双写期并存，前端优先读 surface、回退旧分支） */
  | 'data-surface'
  | 'reasoning-start'
  | 'reasoning-delta'
  | 'reasoning-end'
  | 'text-start'
  | 'text-delta'
  | 'text-end'
  | 'data-sources'
  /** 工单 24 §s09：token 用量账单（仅 ENABLE_USAGE_CAPTURE=true 时下发；关闭时事件序列与改动前一致） */
  | 'usage'
  | 'finish'
  | 'error';

/** Agent 循环硬上限（防死循环兜底；主控为 11/12 号工单预算 4 工具各 1 次） */
const MAX_ITERATIONS = 5;
/**
 * 11/12 号工单：单轮工具调用预算（代码强制，不依赖 prompt 遵从）。
 * 数值来源统一在 tool-denial.ts 的 TOOL_BUDGET_LIMITS —— 拒绝载荷里的 budget_remaining
 * 与这里循环用的上限必须是同一份，否则「还剩几次」会和实际放行逻辑打架。
 */
const MAX_TOOL_CALLS = TOOL_BUDGET_LIMITS.total;
const MAX_REWRITE_CALLS = TOOL_BUDGET_LIMITS.rewrite;
const MAX_WEB_CALLS = TOOL_BUDGET_LIMITS.web;
const MAX_GRAPH_CALLS = TOOL_BUDGET_LIMITS.graph;

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
/**
 * 11 号工单补丁（演示期实测缺陷修复）：把工具门控结果显式告知模型。
 *
 * 缺陷现象：intent=web 时前置管线跳过知识库预检索（intentAllowsKb=false），
 * 上下文里没有任何「知识库不足」的证据，而 SYSTEM_PROMPT 把 web_search 描述为
 * 「仅知识库不足时使用」——模型据此既不调用 web_search，又输出「知识库中未检索到
 * 相关信息」，同时违反「不得编造」与工具门控两条约束。实测 4/4 复现。
 *
 * 修法：按意图注入一段指令，明确本轮可用路径与"预检索为空属正常"，
 * 使门控（代码固定）与模型决策（自由）之间不再有信息落差。
 */
const INTENT_DIRECTIVES: Record<AgentIntent, string> = {
  chitchat:
    '【本轮意图】闲聊寒暄类。无需调用任何工具，直接自然作答，不要提及检索或知识库。',
  preference:
    '【本轮意图】用户个人偏好类。无需调用检索工具，直接结合上下文中的记忆作答。',
  knowledge:
    '【本轮意图】知识库检索。本轮不可联网。已有【知识库检索资料】属预检索结果：足以回答则直接作答；为空或不足时必须调用 retrieve_knowledge，必要时用 rewrite_query 换词重检，仍无果则如实告知用户知识库暂无相关内容。',
  web: '【本轮意图】联网搜索。本轮**不检索企业知识库**，因此没有任何【知识库检索资料】属于正常现象，严禁据此输出「知识库中未检索到相关信息」这类未经检索的结论。你必须调用 web_search 获取公网信息，并基于返回结果作答；若 web_search 返回 0 条或不可用，再如实告知用户公网信息缺失。',
  knowledge_then_web:
    '【本轮意图】先知识库、不足再联网。已有【知识库检索资料】属预检索结果：足以回答则直接作答；缺失或不足时先调用 retrieve_knowledge 补检，仍未覆盖的部分再调用 web_search 联网补充。',
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
- **只能使用资料里出现过的编号**：资料只到 [2] 就绝不能写 [3]；没有资料可引就不标编号。编造编号比不标更糟——用户点开会发现文不对题
- 仅当本轮**实际检索过知识库**且确实没有相关信息时，才可告知用户「知识库中未检索到相关信息」，禁止用记忆或制度背景编造；本轮没有检索知识库时不得作此陈述（那会让用户误以为查过了）
- 引用 Web 结果时在句末以 (来源: 域名) 标注
- 工具不可用或无结果时如实告知，不要编造；若问题无需工具（闲聊、个人偏好），直接回答
- 系统提示中的【本轮意图】段落是给你内部使用的路由指令：禁止在回答里复述或解释本轮意图、工具名、检索过程等内部信息（例如「本轮意图为联网搜索」「不检索企业知识库」「已调用 web_search」），直接输出面向用户的答案正文，不要解释你为什么这样回答
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
  ) {}

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
      // 本轮最终界面蓝图：前置检索与工具路径都可能产出，以最后一次通过校验的为准，
      // 收尾时随消息落库（回放靠它还原卡片，见 docs/engineering/genui-surface.md §5.2）
      let surfaceToPersist: Surface | null = null;

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
      if (kbHit.items.length > 0) {
        this.emit(res, 'data-retrieve', {
          query: plan.rewrittenQuery,
          items: kbHit.items,
        });
        // 生成式 UI 切片：前置检索命中是**最常走的路径**，必须与工具路径一样下发界面蓝图，
        // 否则用户看到的卡片只在「工具调用」分支出现，而绝大多数提问在那之前就已命中。
        surfaceToPersist =
          this.emitSurface(
            res,
            buildKnowledgeSurface({ query: plan.rewrittenQuery, items: kbHit.items }),
          ) ?? surfaceToPersist;
      }
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
      const rewriteTool = this.makeRewriteTool(res, sources);
      const webTool = this.makeWebTool(res, sources);
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

      /**
       * 工单 24 P0 兜底 —— 「判对了却不检索」。
       *
       * 现象（s04 实测 5/50）：意图判成 knowledge、预检索返回 0 条，
       * 模型一次工具都不调，直接用参数记忆答内部制度问题，答案里也没有任何引用。
       *
       * 处理：由代码代调一次 `retrieve_knowledge`，把结果（**包括「0 条命中」这个事实**）
       * 拼进【知识库检索资料】。检索为空时，模型至少拿到"确实查过且没有"的依据，
       * 会答「库内没有相关规定」而不是照着通用常识编一套流程。
       *
       * 为什么不用 `tool_choice` 强制首轮调用（更优雅的做法）：qwen-plus 支持，
       * 但 DeepSeek 的 thinking 模式对 required/指定函数直接返回 400（2026-10-21 实测）。
       * 兜底逻辑不能依赖供应商特性 —— 主回答模型一换，整轮对话就失败。
       *
       * 开关：`FORCE_RETRIEVE_ON_EMPTY=false` 可关闭（默认开）。代调计入工具预算。
       */
      let forcedRetrieveText = '';
      const forceRetrieve = shouldForceRetrieve({
        enabled: process.env.FORCE_RETRIEVE_ON_EMPTY !== 'false',
        intentAllowsKb,
        needRetrieve: plan.needRetrieve,
        isChitchat: plan.isChitchat,
        kbItemCount: kbHit.items.length,
      });
      if (forceRetrieve) {
        try {
          // 让前端和评测都看得见「这次检索是代码补的」—— 否则它只存在于日志里，
          // 评测会误判成「本轮没检索」（s03 的行为一致率就是这么掉下来的）
          this.emit(res, 'data-status', {
            stage: 'retrieve',
            text: '预检索为空，补充检索...',
            forced: true,
          });
          const forced = await retrieveKnowledge(
            { query: this.buildForceQuery(plan, params.content) },
            { question: params.content, scope },
            this.toolDeps(res, sources),
          );
          budget.total += 1;
          forcedRetrieveText = forced.content;
          this.logger.log(
            `预检索为空 → 代调 retrieve_knowledge 一次 grade=${forced.grade} items=${forced.items?.length ?? 0}`,
          );
        } catch (err) {
          this.logger.warn(
            `代调 retrieve_knowledge 失败（不影响主链路）：${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }

      // 6. 手写 tool-calling 循环（v2 事件）；每轮按意图门控 + 剩余预算动态绑定工具（11 号工单）
      const baseModel = this.buildModel(params);
      const chatModelName = this.resolveChatModelName(params);
      const messages: Array<
        SystemMessage | HumanMessage | AIMessage | ToolMessage
      > = [
        new SystemMessage(
          this.buildSystemContext(
            memHits,
            summary,
            kbHit.text || forcedRetrieveText,
            plan.intent,
          ),
        ),
        /**
         * 工单 24 P0：注入历史时**剥掉 assistant 侧的引用标记**。
         *
         * `[n]` 是"本轮"的全局编号 —— 历史里的 `[1]` 指的是上一轮的第 1 条来源，
         * 本轮的第 1 条可能是完全另一个文档。带着旧编号进上下文，模型很容易沿用，
         * 于是出现"只有 1 条来源却引 [3]"这种越界编号（s05 实测到的那例）。
         * 只影响送给模型的 prompt，不动落库内容与前端展示。
         */
        ...history.map((h) =>
          h.role === 'user'
            ? new HumanMessage(h.content)
            : new AIMessage(stripCitationMarkers(h.content)),
        ),
        new HumanMessage(params.content),
      ];

      let answer = '';
      let textSeq = 0;
      let reasoningSeq = 0;
      /**
       * 工单 24 P0：流式引用过滤。越界编号在**下发前**就丢掉，
       * 而不是等生成完再改（那时用户已经看到了 `[3]`）。
       * 合法上限实时读 `sources.length` —— 工具调用会不断登记新来源。
       */
      const citeFilter = new CitationStreamFilter(() => sources.length);
      /**
       * 工单 22：纯拒绝轮的「下一轮强制无工具」开关。
       *
       * 工具常驻后，模型可能发出一批**全部被门控拒绝**的调用。那种轮次里模型没产出任何文本，
       * 拒绝理由刚 push 进 messages 却没人消费 —— 若直接跳出循环，`answer` 为空，
       * 用户会看到「（本次回答未生成内容）」。所以不 break，而是让下一轮不绑工具：
       * 模型先读到拒绝理由，再基于已有信息生成答案。
       */
      let denyToolsNextRound = false;

      for (let step = 1; step <= MAX_ITERATIONS && !aborted; step++) {
        this.emit(res, 'start-step', { step });
        // 工单 22：工具常驻（不再按 allowed() 裁剪），只在纯拒绝轮的下一轮强制空集
        const runtimeTools = denyToolsNextRound ? [] : allTools;
        denyToolsNextRound = false;
        const stream = await (
          runtimeTools.length > 0
            ? baseModel.bindTools(runtimeTools)
            : baseModel
        ).stream(messages);
        let content = '';
        let textOpened = false;
        let reasoningOpened = false;
        /** 本步的 usage（OpenAI 流式协议把它放在最后一帧，choices 为空的那个 chunk） */
        let stepUsage:
          | { input_tokens?: number; output_tokens?: number }
          | undefined;
        const toolCalls = new Map<
          number,
          { id: string; name: string; args: string }
        >();

        for await (const chunk of stream) {
          if (aborted) break;
          // 工单 24 §s09：usage 帧只在最后一帧出现且 content 为空，不能靠 content 判断
          if (this.tracing.usageEnabled) {
            const um = (
              chunk as {
                usage_metadata?: { input_tokens?: number; output_tokens?: number };
              }
            ).usage_metadata;
            if (um) stepUsage = um;
          }
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
            const safe = citeFilter.push(delta);
            if (safe) {
              if (!textOpened) {
                textSeq += 1;
                this.emit(res, 'text-start', { id: `text_${textSeq}` });
                textOpened = true;
              }
              content += safe;
              this.emit(res, 'text-delta', { id: `text_${textSeq}`, delta: safe });
            }
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
        // 流结束：把过滤器残留的尾部吐出去，否则末字若是个孤立的 `[` 会被吞掉
        const citeTail = citeFilter.flush();
        if (citeTail) {
          if (!textOpened) {
            textSeq += 1;
            this.emit(res, 'text-start', { id: `text_${textSeq}` });
            textOpened = true;
          }
          content += citeTail;
          this.emit(res, 'text-delta', { id: `text_${textSeq}`, delta: citeTail });
        }
        if (reasoningOpened)
          this.emit(res, 'reasoning-end', { id: `reasoning_${reasoningSeq}` });
        if (textOpened) this.emit(res, 'text-end', { id: `text_${textSeq}` });
        answer += content;
        // 每步单独记一条：Agent 循环一轮里有工具调用时会产生多步，合并会丢掉「多轮检索贵在哪」
        if (stepUsage) {
          this.tracing.recordUsage('answer', {
            model: chatModelName,
            input: stepUsage.input_tokens,
            output: stepUsage.output_tokens,
          });
        }

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
            // 工单 22：拒绝原因结构化 —— 区分「本轮不该用」（intent_gate）与
            // 「这次用完了」（budget_total / budget_per_tool），两者对模型的启示不同
            const denial = buildToolDenial(name, intentToolNames, budget);
            messages.push(
              new ToolMessage({
                tool_call_id: tc.id ?? `call_${name}`,
                content: `工具 ${name} 本轮不可用（${denial.remediation}）。请立即基于已有信息回答。`,
                // ToolMessage.content 必须是字符串，结构化部分挂 kwargs：
                // 不进 prompt，供 Langfuse（工单 13）与评测断言读取
                additional_kwargs: { tool_denial: denial },
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
              // 生成式 UI 切片：同一份数据额外下发一份界面蓝图。
              // 双写期前端优先读 surface，旧事件保留给未迁移的消费方（AiProcessTimeline）。
              surfaceToPersist =
                this.emitSurface(res, buildKnowledgeSurface({ query, items })) ??
                surfaceToPersist;
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
        // 本轮工具调用全部被意图门控/预算拦截 → 下一轮不绑工具，强制基于已有信息生成
        // （工单 22：原实现是 break，但那样刚 push 的拒绝 ToolMessage 不会再有模型调用去消费，
        //   该轮 content 为空时会触发「本次回答未生成内容」兜底）
        const callCount = aiWithTools.tool_calls?.length ?? 0;
        if (callCount > 0 && deniedCount === callCount) {
          denyToolsNextRound = true;
        }
      }

      if (aborted) {
        this.logger.log(
          `AI 对话客户端断连 userId=${userId} 已生成 ${answer.length} 字（已落库）`,
        );
      }

      // 5. 引用过滤（11 号工单阶段6：只下发被 [n] 引用的来源；无标记回退全量）→ data-sources
      const finalSources = this.filterCitedSources(answer, sources);
      this.emit(res, 'data-sources', { sources: finalSources });
      // 工单 24 P0：越界引用编号（引了 [n] 但本轮没有第 n 条来源）—— 只报不改正文
      const invalidCitations = findInvalidCitations(answer, sources.length);
      if (invalidCitations.length > 0) {
        this.logger.warn(
          `答案含越界引用编号 [${invalidCitations.join('],[')}]，本轮来源共 ${sources.length} 条`,
        );
      }
      if (citeFilter.droppedCount > 0) {
        this.logger.warn(
          `流式过滤丢掉了 ${citeFilter.droppedCount} 个越界引用编号（本轮来源 ${sources.length} 条）`,
        );
      }

      // 6. suggestions（非流式快速生成，失败兜底固定池）→ finish
      const suggestions = await this.generateSuggestions(messages).catch(
        () => FALLBACK_SUGGESTIONS,
      );
      // 工单 24 §s09：把本轮各环节 token 用量下发给客户端汇总。
      // 只在采集开关打开时下发 —— 关闭时事件序列与改动前逐字节一致（验收标准 #7）。
      // 注意：Mem0 事实抽取是 `void ingestMem0()` 在响应结束后异步跑的，不在这份账单里。
      if (this.tracing.usageEnabled) {
        this.emit(res, 'usage', { entries: this.tracing.usageSnapshot() });
      }
      // 工单 13：附带 traceId（tracing 未启用时为 undefined，JSON 序列化时自动省略），供评测/前端关联
      this.emit(res, 'finish', {
        messageId,
        suggestions,
        traceId: trace.traceId(),
        // 工单 24 P0：越界编号随 finish 下发，前端/评测可直接统计（无越界时为空数组，省略）
        ...(invalidCitations.length > 0 ? { invalidCitations } : {}),
        // 被流式过滤器丢掉的越界编号数 —— 这才是「模型想编造几次」的真实计数
        ...(citeFilter.droppedCount > 0 ? { droppedCitations: citeFilter.droppedCount } : {}),
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
        surfaceToPersist,
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
      /**
       * `apiKey` 才是 @langchain/openai v1 真正读取的字段；`openAIApiKey` 在该版本被忽略，
       * 之前一直能用是因为 process.env.OPENAI_API_KEY 恰好与配置同值。
       * 一旦给轻量模型配独立供应商（键不同），只传 openAIApiKey 会静默回落到 env 的旧 key → 401。
       */
      apiKey: this.config.get<string>('OPENAI_API_KEY'),
      openAIApiKey: this.config.get<string>('OPENAI_API_KEY'),
      temperature: thinking ? undefined : (params.temperature ?? 0.3),
      configuration: { baseURL: this.config.get<string>('EMBEDDING_BASE_URL') },
      // 工单 13：构造器级回调，本轮所有模型调用（含多步 Agent 循环）自动进同一 trace
      callbacks: this.tracing.current(),
      // 工单 24 §s09：显式要求最后一帧带 usage。@langchain/openai 的 streamUsage 默认已开，
      // 这里写出来是为了「不依赖默认值」—— 只在开关打开时传，关闭时请求体与改动前逐字节一致。
      ...(this.tracing.usageEnabled
        ? { streamOptions: { include_usage: true } }
        : {}),
    };
    const modelName = this.resolveChatModelName(params);
    // dashscope compatible-mode：thinking 经 modelKwargs 合入请求体顶层 enable_thinking（LangChain 无 extraBody 字段；thinking 模式下 temperature 不生效，不传）
    const ctorArgs = thinking
      ? { ...base, modelName, modelKwargs: { enable_thinking: true } }
      : { ...base, modelName };
    return new ChatOpenAI(ctorArgs as never);
  }

  /** 主模型名（buildModel 与用量上报共用一处，避免两处漂移） */
  private resolveChatModelName(params: AiChatStreamParams): string {
    return params.enableThinking === true
      ? 'qwen-plus-latest'
      : (params.model ?? this.config.get<string>('LLM_MODEL', 'qwen-plus'));
  }

  /**
   * 从一次非流式 `invoke()` 的返回值里取 token 用量并上报（工单 24 §s09）。
   * 取不到 usage 就静默跳过，不影响业务。
   */
  private recordInvokeUsage(stage: string, resp: unknown, model: string): void {
    if (!this.tracing.usageEnabled) return;
    const um = (
      resp as { usage_metadata?: { input_tokens?: number; output_tokens?: number } }
    )?.usage_metadata;
    if (!um) return;
    this.tracing.recordUsage(stage, {
      model,
      input: um.input_tokens,
      output: um.output_tokens,
    });
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
      const model = this.buildUtilityModel(300, this.planTimeoutMs());
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
      this.recordInvokeUsage('plan', resp, this.utilityModelName());
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
      const model = this.buildUtilityModel(500, this.gradeTimeoutMs());
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
      this.recordInvokeUsage('grade', resp, this.utilityModelName());
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

  /**
   * 引用登记（11 号工单阶段6）：返回全局编号 [n]，与最终 sources 序号一致；
   * knowledge 按 doc_id 去重、web 按 url 去重，重复登记返回既有编号。
   *
   * 工单 23：去重逻辑已下沉到 tools/source-registry.ts，这里只做委托 ——
   * 前置管线（KB 预检索）仍走本方法，保持调用点不变。
   */
  private registerSource(
    sources: AiSourceDraft[],
    draft: AiSourceDraft,
  ): number {
    return createSourceRegistry(sources).register(draft);
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
          answer.includes(safeDomain(s.url))
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
    intent: AgentIntent,
  ): string {
    const sections: string[] = [SYSTEM_PROMPT, INTENT_DIRECTIVES[intent]];
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
      // 记忆抽取在响应结束后异步跑，不计入下发给客户端的 usage 事件，但服务端可见
      this.recordInvokeUsage('memory', resp, this.utilityModelName());
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

  /** 代调检索用的 query：优先模型给的建议检索词，其次改写句，最后原问题 */
  private buildForceQuery(plan: PlanResult, question: string): string {
    if (plan.suggestedTerms.length > 0) return plan.suggestedTerms.join(' ');
    return plan.rewrittenQuery || question;
  }

  /** 轻量模型名（工单 24 §s09：用量上报也要带同一个名字，避免与构建处漂移） */
  private utilityModelName(): string {
    return this.config.get<string>('MEMORY_LLM_MODEL', 'qwen-turbo');
  }

  /**
   * 意图路由 / 切题评估的超时（毫秒）。
   *
   * 为什么要可配：这两个环节原来写死 5s，而 `MEMORY_LLM_MODEL`（qwen3.8-flash）
   * 频繁超过 5s。一旦超时，`planIntent` 直接 fallback 成 `knowledge`、
   * `gradeChunks` 直接放行全量资料 —— **约四分之一的轮次根本没做真正的判断**，
   * 且过程中不会报错，只在日志里留一行 WARN。
   *
   * 2026-10-21 实测：50 条 × 2 轮共 100 次请求，意图路由降级 27 次。
   * 放宽到 15s 后由 `PLAN_TIMEOUT_MS` 控制，默认 15s（代价是最慢轮次首字延迟变长）。
   */
  private planTimeoutMs(): number {
    return Number(this.config.get('PLAN_TIMEOUT_MS', 15000));
  }

  /** 切题评估超时；默认保持原值 5s，可用 `GRADE_TIMEOUT_MS` 覆盖 */
  private gradeTimeoutMs(): number {
    return Number(this.config.get('GRADE_TIMEOUT_MS', 5000));
  }

  /** 轻量工具模型（改写判断/摘要/记忆抽取共用）：MEMORY_LLM_MODEL 默认 qwen-turbo，快速失败 */
  private buildUtilityModel(maxTokens: number, timeoutMs: number): ChatOpenAI {
    /**
     * 轻量模型可以走**独立端点**（`UTILITY_API_KEY` / `UTILITY_BASE_URL`），
     * 不填则回落到主端点（原行为）。用于「意图路由打算换更快的供应商」这类实验：
     * 只改这一段，主回答与向量化不受影响 —— 向量化必须留在 DashScope。
     */
    const utilityKey = this.config.get<string>('UTILITY_API_KEY');
    const utilityBase = this.config.get<string>('UTILITY_BASE_URL');
    return new ChatOpenAI({
      apiKey: utilityKey || this.config.get<string>('OPENAI_API_KEY'),
      openAIApiKey: utilityKey || this.config.get<string>('OPENAI_API_KEY'),
      modelName: this.utilityModelName(),
      /**
       * 默认 0.1。评测要可复现时设 `UTILITY_TEMPERATURE=0` ——
       * 意图路由/切题评估都是「输出 JSON 分类」任务，0.1 的采样会带来同题不同判，
       * 而这两个环节一旦判错，下游检索、引用、工具选择全链路都跟着变。
       */
      temperature: Number(this.config.get('UTILITY_TEMPERATURE', 0.1)),
      maxTokens,
      maxRetries: 0,
      configuration: {
        baseURL: utilityBase || this.config.get<string>('EMBEDDING_BASE_URL'),
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
   * 装配工具依赖（工单 23）。
   *
   * 每次请求新建：`sources` 是本次请求的引用池，`res` 绑定本次 SSE 流。
   * 工具层因此没有请求级状态，可独立单测。
   */
  private toolDeps(res: Response, sources: AiSourceDraft[]): ToolDeps {
    return {
      rag: this.ragSearch,
      kg: this.kg,
      grader: (question, chunks) => this.gradeChunks(question, chunks),
      sources: createSourceRegistry(sources),
      events: {
        status: (stage, text) => this.emit(res, 'data-status', { stage, text }),
      },
      logger: this.logger,
      config: {
        excerptLen: EXCERPT_LEN,
        tavilyApiKey: this.config.get<string>('TAVILY_SEARCH'),
      },
    };
  }

  /**
   * 阶段2+3 捆绑工具 retrieve_knowledge（11 号工单，工单 23 起实现下沉到 tools/）：
   * 混合检索（仅可见文档）+ 自动切题评估，返回评估结论与切题资料（全局 [n] 编号，
   * 与 data-sources 序号一致）；09 号工单 scope 过滤保留。
   *
   * 本方法只保留 tool() 的模型可见契约（name / description / schema），**一字不改** ——
   * 契约散进 tools/ 会失去唯一注册表。
   */
  private makeRetrieveTool(
    res: Response,
    sources: AiSourceDraft[],
    question: string,
    scope?: VisibilityScope,
  ) {
    const deps = this.toolDeps(res, sources);
    return tool(
      (input: { query: string }) =>
        retrieveKnowledge(input, { question, scope }, deps),
      {
        name: 'retrieve_knowledge',
        description:
          '检索企业内部知识库并自动做切题评估（BM25+向量混合检索、仅当前用户可见文档），返回评估结论与按全局编号的切题资料；回答企业内部制度/文档/知识类问题时优先使用',
        schema: z.object({ query: z.string().describe('检索关键词或问题') }),
      },
    );
  }

  /**
   * 阶段4 环内改写工具 rewrite_query（11 号工单，工单 23 起实现下沉到 tools/）：
   * 依据不足原因与新检索词换一种问法再查；是否改写、用什么词由模型自主决定，
   * 全轮最多 1 次（预算在循环中强制）。
   */
  private makeRewriteTool(res: Response, sources: AiSourceDraft[]) {
    const deps = this.toolDeps(res, sources);
    return tool(
      (input: { reason: string; terms: string[] }) => rewriteQuery(input, deps),
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

  /** Web 搜索工具（Tavily，v2：返回 results 含 title/url；未配 key/超时/异常降级）—— 工单 23 起实现下沉到 tools/ */
  private makeWebTool(res: Response, sources: AiSourceDraft[]) {
    const deps = this.toolDeps(res, sources);
    return tool((input: { query: string }) => webSearch(input, deps), {
      name: 'web_search',
      description: '搜索公网信息（时效性/外部知识），仅在知识库无法回答时使用',
      schema: z.object({ query: z.string().describe('搜索关键词') }),
    });
  }

  /**
   * 图谱检索工具 retrieve_graph（12 号工单，工单 23 起实现下沉到 tools/）：
   * 调 kgService.searchGraph 查实体关系子图，每条 RELATED_TO 三元组登记一条 kind='graph' 来源
   * （参与全局 [n] 编号），并返回 entities/relations 供循环 emit data-graph；
   * 不过 Grader（子串精确命中噪音低，topK 截断直进）；Neo4j 不可用/查询失败降级为提示文本，流不中断。
   */
  private makeGraphTool(res: Response, sources: AiSourceDraft[]) {
    const deps = this.toolDeps(res, sources);
    return tool((input: { query: string }) => retrieveGraph(input, deps), {
      name: 'retrieve_graph',
      description:
        '检索企业知识图谱中的实体关系子图（人/组织/技术/术语等实体及其关联），适合回答「实体之间的关系、谁审批、谁归属哪个流程」类问题；作为文档检索的补充',
      schema: z.object({ query: z.string().describe('实体名或关系关键词') }),
    });
  }

  /** 基于最终 messages 生成 6 条推荐追问（非流式，失败由调用方兜底固定池） */
  private async generateSuggestions(
    messages: Array<SystemMessage | HumanMessage | AIMessage | ToolMessage>,
  ): Promise<string[]> {
    const suggestionModel = new ChatOpenAI({
      apiKey: this.config.get<string>('OPENAI_API_KEY'),
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
    this.recordInvokeUsage(
      'suggestions',
      resp,
      this.config.get<string>('LLM_MODEL', 'qwen-plus'),
    );
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

  /**
   * 下发 surface（生成式 UI 的界面蓝图）。
   *
   * 校验不通过时**静默降级**：只记 warn，不阻塞对话，也不下发半个界面。
   * 前端在这种情况下退回旧 data-* 分支，用户看到的东西不会比改造前少。
   */
  private emitSurface(res: Response, surface: Surface): Surface | null {
    const result = validateSurface(surface, CATALOG);
    if (!result.ok || !result.surface) {
      this.logger.warn(
        `surface 校验失败，降级为旧事件渲染: ${result.dropped
          .map((d) => `${d.id}(${d.reason})`)
          .join('; ')}`,
      );
      return null;
    }
    if (result.dropped.length > 0) {
      // 局部丢弃：父级继续渲染，只少了坏掉的子树
      this.logger.warn(
        `surface 部分节点被丢弃: ${result.dropped
          .map((d) => `${d.id}(${d.reason})`)
          .join('; ')}`,
      );
    }
    this.emit(res, 'data-surface', { surface: result.surface });
    // 返回已校验的成品：调用方据此决定是否随消息落库（坏 surface 不写库）
    return result.surface;
  }
}
