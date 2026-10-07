import { Logger } from '@nestjs/common';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { LangfuseSpanProcessor } from '@langfuse/otel';

const logger = new Logger('Tracing');

let sdk: NodeSDK | undefined;

/**
 * tracing 是否启用：LANGFUSE_ENABLED 未被显式置为 false，且公/私钥齐备。
 * 环境变量来自 .env（main.ts 中已先于本模块导入加载）。
 */
export function isTracingEnabled(): boolean {
  if ((process.env.LANGFUSE_ENABLED ?? '').toLowerCase() === 'false')
    return false;
  return Boolean(
    process.env.LANGFUSE_PUBLIC_KEY && process.env.LANGFUSE_SECRET_KEY,
  );
}

/**
 * 启动 Langfuse tracing（OpenTelemetry NodeSDK + LangfuseSpanProcessor）。
 *
 * 调用时机：main.ts 中「.env 加载之后、NestFactory.create 之前」（凭据取自 process.env；
 * Langfuse 官方明确要求先加载环境变量再初始化，否则会用错/缺失凭据）。
 * 失败仅记日志并整体停用，不抛错——对齐项目「降级不报错」原则。
 */
export function initTracing(): void {
  if (!isTracingEnabled()) {
    logger.log(
      'Langfuse tracing 未启用（LANGFUSE_ENABLED=false 或缺少 API Key），跳过初始化',
    );
    return;
  }
  try {
    sdk = new NodeSDK({
      spanProcessors: [
        new LangfuseSpanProcessor({
          publicKey: process.env.LANGFUSE_PUBLIC_KEY,
          secretKey: process.env.LANGFUSE_SECRET_KEY,
          baseUrl: process.env.LANGFUSE_BASE_URL,
          environment:
            process.env.LANGFUSE_TRACING_ENVIRONMENT ?? process.env.NODE_ENV,
          release: process.env.LANGFUSE_RELEASE,
        }),
      ],
    });
    sdk.start();
    logger.log(
      `Langfuse tracing 已启用 baseUrl=${process.env.LANGFUSE_BASE_URL ?? '默认'}`,
    );
  } catch (err) {
    sdk = undefined;
    logger.warn(
      `Langfuse tracing 初始化失败，已整体降级: ${err instanceof Error ? err.message : err}`,
    );
  }
}

/** 进程退出前冲刷尚未上报的 span 队列（可选调用；长驻进程由后台批量上报兜底） */
export async function shutdownTracing(): Promise<void> {
  const current = sdk;
  sdk = undefined;
  if (!current) return;
  try {
    await current.shutdown();
  } catch (err) {
    logger.warn(
      `Langfuse tracing 关停异常: ${err instanceof Error ? err.message : err}`,
    );
  }
}
