/**
 * MinerU 接入层类型定义
 *
 * 三条通道共用一个 ParseResult，业务代码不需要关心底层走的是哪条。
 */

/** 解析通道：云端精准 / 云端轻量 / 自托管 */
export type MineruProvider = 'cloud' | 'flash' | 'self-hosted';

/** 自托管 mineru-api 的解析后端 */
export type MineruBackend =
  | 'pipeline'
  | 'vlm-auto-engine'
  | 'hybrid-auto-engine'
  | 'vlm-http-client'
  | 'hybrid-http-client';

export interface ParseOptions {
  /** 业务侧文档ID（上传接口生成的 id），仅用于日志追踪 */
  docId?: string;
  /** 页范围，形如 "1-20"；注意 Agent 轻量 API 不支持逗号分隔 */
  pages?: string;
  /** OCR 语言，自托管默认 ["ch"]，云端默认 ch */
  language?: string;
  /** 云端模型版本 */
  model?: 'pipeline' | 'vlm' | 'html';
  /** 单次解析超时，毫秒 */
  timeoutMs?: number;
}

export interface ParseResult {
  markdown: string;
  /** 提取到的图片。不同通道结构不一致（自托管是 {文件名: base64}，云端是列表） */
  images?: unknown;
  /** middle.json，仅自托管与云端精准模式返回 */
  middleJson?: unknown;
  /** MinerU 侧生成的解析任务/文件 ID（云端为 taskId，自托管为 task_id） */
  taskId?: string;
  provider: MineruProvider;
  costMs: number;
}
