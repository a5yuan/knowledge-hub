import { Injectable, Logger, OnModuleInit, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { unlink, writeFile } from 'node:fs/promises';

import type {
  MineruBackend,
  MineruProvider,
  ParseOptions,
  ParseResult,
} from './mineru.types';

/**
 * MinerU 统一接入层
 *
 * 三个通道（MINERU_PROVIDER 切换）：
 *   cloud       -> 官方云 API 精准解析（需 Token，≤200MB/≤200页，出 Markdown+JSON）
 *   flash       -> 官方云 API 轻量解析（免 Token，≤10MB/≤20页，只出 Markdown）
 *   self-hosted -> 自托管 mineru-api（Docker，可纯内网）
 *
 * 业务侧只调 parse()，不感知通道差异。
 * 任务状态由业务侧（Mongo parse_state）管理，本服务不持有任务表。
 */
@Injectable()
export class MineruService implements OnModuleInit {
  private readonly logger = new Logger(MineruService.name);

  private readonly provider: MineruProvider;
  private readonly apiToken: string;
  private readonly selfHostedUrl: string;
  private readonly backend: MineruBackend;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;

  constructor(private readonly config: ConfigService) {
    this.provider = (this.config.get<string>('MINERU_PROVIDER') ?? 'flash') as MineruProvider;
    this.apiToken = this.config.get<string>('MINERU_API_TOKEN') ?? '';
    this.selfHostedUrl = (this.config.get<string>('MINERU_SELF_HOSTED_URL') ?? 'http://127.0.0.1:8000').replace(/\/+$/, '');
    this.backend = (this.config.get<string>('MINERU_BACKEND') ?? 'pipeline') as MineruBackend;
    this.timeoutMs = Number(this.config.get<string>('MINERU_TIMEOUT_MS') ?? 600_000);
    this.maxRetries = Number(this.config.get<string>('MINERU_MAX_RETRIES') ?? 3);
  }

  async onModuleInit(): Promise<void> {
    this.logger.log(`MinerU provider = ${this.provider}`);
    if (this.provider === 'self-hosted') {
      this.logger.log(`MinerU 自托管地址 = ${this.selfHostedUrl}，backend = ${this.backend}`);
      // 只打日志不抛错：让应用能起来，解析时再暴露问题
      try {
        const health = await this.health();
        this.logger.log(`MinerU 服务健康检查通过: ${JSON.stringify(health)}`);
      } catch (err) {
        this.logger.warn(`MinerU 健康检查失败，服务可能未启动: ${(err as Error).message}`);
      }
    }
  }

  // ---------------------------------------------------------------- 对外主入口

  /**
   * 同步解析。由业务侧放在后台任务中调用，勿在 HTTP 请求里直接 await 大文件。
   */
  async parse(buffer: Buffer, filename: string, options: ParseOptions = {}): Promise<ParseResult> {
    const startedAt = Date.now();
    let result: ParseResult;

    switch (this.provider) {
      case 'self-hosted':
        result = await this.parseSelfHosted(buffer, filename, options);
        break;
      case 'cloud':
        result = await this.parseViaSdk(buffer, filename, options, true);
        break;
      case 'flash':
        result = await this.parseViaSdk(buffer, filename, options, false);
        break;
      default:
        throw new ServiceUnavailableException(`未知的 MINERU_PROVIDER: ${this.provider}`);
    }

    result.costMs = Date.now() - startedAt;
    this.logger.log(`解析完成 docId=${options.docId ?? '-'} ${filename} 通道=${result.provider} 耗时=${result.costMs}ms 长度=${result.markdown.length} mineruTaskId=${result.taskId ?? '-'}`);
    return result;
  }

  /** 透传自托管服务的健康信息 */
  async health(): Promise<unknown> {
    if (this.provider !== 'self-hosted') {
      return { provider: this.provider, note: '云端通道无本地健康检查' };
    }
    const res = await fetch(`${this.selfHostedUrl}/health`, {
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) {
      throw new Error(`GET /health 返回 ${res.status}`);
    }
    return res.json();
  }

  // ------------------------------------------------------------------ 内部实现

  /**
   * 走官方 SDK 调云端 API。
   *
   * 用动态 import + 非字面量说明符：这样只走 self-hosted 的项目不必装这个包，
   * 也避免 TS 在未安装时报「找不到模块」。
   */
  private async parseViaSdk(
    buffer: Buffer,
    filename: string,
    options: ParseOptions,
    precision: boolean,
  ): Promise<ParseResult> {
    const mod: any = await import('mineru-open-sdk' as any).catch(() => null);
    if (!mod) {
      throw new ServiceUnavailableException(
        '未安装 mineru-open-sdk，请执行 npm i mineru-open-sdk（或把 MINERU_PROVIDER 改成 self-hosted）',
      );
    }

    const client = precision ? new mod.MinerU(this.apiToken) : new mod.MinerU();
    if (precision && !this.apiToken) {
      throw new ServiceUnavailableException('MINERU_PROVIDER=cloud 需要 MINERU_API_TOKEN，请到 mineru.net 申请');
    }

    // SDK 的文件入参是本地路径（不是 Buffer），所以先落临时文件，用完删掉
    const tmpPath = join(tmpdir(), `mineru-${randomUUID()}-${filename}`);
    await writeFile(tmpPath, buffer);

    try {
      let raw: any;
      if (precision) {
        raw = await client.extract(tmpPath, {
          model: options.model ?? 'vlm', // vlm 精度更高；pipeline 更快更省
          language: options.language ?? 'ch',
          pages: options.pages,
          // 注意：SDK 文档标注 timeout 单位为秒
          timeout: Math.ceil((options.timeoutMs ?? this.timeoutMs) / 1000),
        });
      } else {
        raw = await client.flashExtract(tmpPath, {
          language: options.language ?? 'ch',
          timeout: Math.ceil((options.timeoutMs ?? this.timeoutMs) / 1000),
        });
      }

      if (raw?.error) {
        throw new ServiceUnavailableException(`解析失败: ${raw.error}`);
      }

      return {
        markdown: raw?.markdown ?? '',
        images: raw?.images,
        middleJson: undefined,
        taskId: raw?.taskId ? String(raw.taskId) : undefined,
        provider: precision ? 'cloud' : 'flash',
        costMs: 0, // 外层 parse() 会覆盖
      };
    } finally {
      await unlink(tmpPath).catch(() => undefined);
    }
  }

  /**
   * 走自托管 mineru-api。
   * 用「提交异步任务 + 轮询」而不是同步的 /file_parse，
   * 因为同步接口在大文件上极易撞到网关和 fetch 超时。
   */
  private async parseSelfHosted(
    buffer: Buffer,
    filename: string,
    options: ParseOptions,
  ): Promise<ParseResult> {
    const taskId = await this.submitTask(buffer, filename, options);
    await this.waitForTask(taskId, options.timeoutMs ?? this.timeoutMs);

    const res = await fetch(`${this.selfHostedUrl}/tasks/${taskId}/result`, {
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) {
      throw new ServiceUnavailableException(`取解析结果失败: HTTP ${res.status}`);
    }

    const payload: any = await res.json();
    // 自托管返回结构: { results: [{ file_name, md_content, images, middle_json }] }
    const first = payload?.results?.[0];
    if (!first) {
      throw new ServiceUnavailableException('解析结果为空，response 结构可能已变更');
    }

    return {
      markdown: first.md_content ?? first.markdown ?? '',
      images: first.images,
      middleJson: first.middle_json,
      taskId,
      provider: 'self-hosted',
      costMs: 0,
    };
  }

  private async submitTask(
    buffer: Buffer,
    filename: string,
    options: ParseOptions,
  ): Promise<string> {
    const form = new FormData();
    form.append('files', new Blob([new Uint8Array(buffer)]), filename);
    // ⚠️ 必须显式指定 backend：mineru-api 默认是 hybrid-auto-engine，纯 CPU 会跑不起来
    form.append('backend', this.backend);
    form.append('parse_method', 'auto');
    form.append('lang_list', options.language ?? 'ch');
    form.append('formula_enable', 'true');
    form.append('table_enable', 'true');
    form.append('return_md', 'true');
    form.append('return_middle_json', 'false');
    form.append('return_images', 'false');
    if (options.pages) {
      const [start, end] = options.pages.split('-');
      if (start) form.append('start_page_id', String(Number(start) - 1)); // 服务端 0-indexed
      if (end) form.append('end_page_id', String(Number(end) - 1));
    }

    // 并发超限时 mineru-api 直接返回 503（不排队），所以必须退避重试
    const res = await this.withRetry(
      () =>
        fetch(`${this.selfHostedUrl}/tasks`, {
          method: 'POST',
          body: form,
          signal: AbortSignal.timeout(120_000),
        }),
      (r) => r.status === 503 || r.status === 429,
      'POST /tasks',
    );

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new ServiceUnavailableException(`提交解析任务失败: HTTP ${res.status} ${text.slice(0, 200)}`);
    }

    const payload: any = await res.json();
    const taskId = payload?.task_id ?? payload?.taskId;
    if (!taskId) {
      throw new ServiceUnavailableException(`提交成功但未返回 task_id: ${JSON.stringify(payload).slice(0, 200)}`);
    }
    return String(taskId);
  }

  private async waitForTask(taskId: string, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    let lastState = '';

    while (Date.now() < deadline) {
      const res = await fetch(`${this.selfHostedUrl}/tasks/${taskId}`, {
        signal: AbortSignal.timeout(30_000),
      });

      // 404 = 已过保留期被清理，或服务重启过（任务状态是进程内的）
      if (res.status === 404) {
        throw new ServiceUnavailableException(
          `任务 ${taskId} 已不存在（可能服务重启或超过结果保留期）`,
        );
      }
      if (!res.ok) {
        throw new ServiceUnavailableException(`查询任务状态失败: HTTP ${res.status}`);
      }

      const payload: any = await res.json();
      const state = String(payload?.state ?? '');
      if (state !== lastState) {
        this.logger.log(`任务 ${taskId} 状态: ${state}${payload?.queued_ahead ? ` (前方排队 ${payload.queued_ahead})` : ''}`);
        lastState = state;
      }

      if (['done', 'success', 'completed'].includes(state)) return;
      if (['failed', 'error'].includes(state)) {
        throw new ServiceUnavailableException(`解析失败: ${payload?.err_msg ?? payload?.error ?? state}`);
      }

      await this.sleep(2_000);
    }

    throw new ServiceUnavailableException(`解析超时（${Math.round(timeoutMs / 1000)}s），最后状态: ${lastState}`);
  }

  private async withRetry(
    fn: () => Promise<Response>,
    shouldRetry: (res: Response) => boolean,
    tag: string,
  ): Promise<Response> {
    let lastErr: unknown;
    for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
      try {
        const res = await fn();
        if (!shouldRetry(res) || attempt === this.maxRetries) return res;
        const backoff = 1_000 * 2 ** (attempt - 1);
        this.logger.warn(`${tag} 返回 ${res.status}，${backoff}ms 后重试 (${attempt}/${this.maxRetries})`);
        await this.sleep(backoff);
      } catch (err) {
        lastErr = err;
        if (attempt === this.maxRetries) throw err;
        await this.sleep(1_000 * 2 ** (attempt - 1));
      }
    }
    throw lastErr ?? new Error(`${tag} 重试耗尽`);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
