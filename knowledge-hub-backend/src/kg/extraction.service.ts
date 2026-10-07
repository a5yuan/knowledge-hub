import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ChatOpenAI } from '@langchain/openai';
import { SystemMessage, HumanMessage } from '@langchain/core/messages';
import type { BaseMessage } from '@langchain/core/messages';
import { Runnable } from '@langchain/core/runnables';
import { z } from 'zod';

/** 实体类型枚举（去重键的一部分） */
export const ENTITY_TYPES = ['person', 'org', 'tech', 'location', 'term', 'other'] as const;

/** 实体/关系抽取结果 schema（structured output 约束返回 JSON 格式） */
export const ExtractionSchema = z.object({
  entities: z.array(
    z.object({
      name: z.string().describe('实体名称，如：张三、阿里巴巴、Vue'),
      type: z.enum(ENTITY_TYPES).describe('实体类型'),
      description: z.string().optional().describe('一句话实体描述'),
    }),
  ),
  relations: z.array(
    z.object({
      source: z.object({ name: z.string(), type: z.enum(ENTITY_TYPES) }),
      target: z.object({ name: z.string(), type: z.enum(ENTITY_TYPES) }),
      relation: z.string().describe('动词短语，如：隶属/参与/使用/研发'),
    }),
  ),
});

export type EntityRef = z.infer<typeof ExtractionSchema>['entities'][number];
export type Extraction = z.infer<typeof ExtractionSchema>;

const SYSTEM_PROMPT = `你是企业知识库的知识图谱构建助手。从给定的文档片段中抽取实体和实体间关系。

要求：
1. 实体类型限定为：person(人物)、org(组织)、tech(技术)、location(地点)、term(术语)、other(其他)
2. 只抽取文本中明确出现的实体，不要编造；实体名保持原文写法
3. 关系的 source 和 target 必须出自本次抽取的 entities 列表
4. relation 用简短动词短语（如：隶属、参与、使用、研发、任职）
5. 没有可抽取的内容时返回空数组`;

/**
 * 实体/关系抽取服务（对应架构图"抽取实体""抽取关系"）
 * ChatOpenAI(qwen-plus) + withStructuredOutput，经 OpenAI 兼容端点调用（dashscope compatible-mode）
 */
@Injectable()
export class ExtractionService {
  private readonly logger = new Logger(ExtractionService.name);
  private chain?: Runnable<BaseMessage[], Extraction>;

  constructor(private readonly config: ConfigService) { }

  /** 懒初始化抽取链（首次调用时读取配置） */
  private getChain() {
    if (this.chain) return this.chain;
    const baseUrl = this.config.get<string>('EMBEDDING_BASE_URL');
    const model = this.config.get<string>('LLM_MODEL', 'qwen-plus');
    const apiKey = this.config.get<string>('OPENAI_API_KEY');
    if (!baseUrl || !apiKey) {
      throw new Error('抽取配置缺失，需设置 EMBEDDING_BASE_URL / OPENAI_API_KEY（复用向量化端点）');
    }
    const chat = new ChatOpenAI({
      openAIApiKey: apiKey,
      modelName: model,
      temperature: 0,
      configuration: { baseURL: baseUrl },
    });
    this.chain = chat.withStructuredOutput(ExtractionSchema) as unknown as Runnable<BaseMessage[], Extraction>;
    return this.chain;
  }

  /** 抽取单个文本块的实体与关系，含脏数据过滤与去重 */
  async extract(text: string): Promise<Extraction> {
    const chain = this.getChain();
    const raw = await chain.invoke([new SystemMessage(SYSTEM_PROMPT), new HumanMessage(text)]);
    return this.postProcess(raw);
  }

  /** 代码侧兜底：实体按 name+type 去重；关系两端必须存在于实体列表、去重、去掉自环 */
  private postProcess(raw: Extraction): Extraction {
    const entityKeys = new Set(raw.entities.map((e) => `${e.type}|${e.name}`));
    const entities: EntityRef[] = [];
    const seen = new Set<string>();
    for (const e of raw.entities) {
      const key = `${e.type}|${e.name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      entities.push(e);
    }
    const relations = raw.relations.filter((r) => {
      if (!entityKeys.has(`${r.source.type}|${r.source.name}`)) return false;
      if (!entityKeys.has(`${r.target.type}|${r.target.name}`)) return false;
      if (r.source.name === r.target.name && r.source.type === r.target.type) return false;
      return true;
    });
    return { entities, relations };
  }
}
