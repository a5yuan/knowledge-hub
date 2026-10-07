import { Global, Module } from '@nestjs/common';
import { TracingService } from './tracing.service';

/**
 * 可观测模块（工单 13）：@Global 供各业务模块直接注入 TracingService，
 * 无依赖、无副作用——真正的 OTel SDK 由 main.ts 的 initTracing() 在启动早期启动。
 */
@Global()
@Module({
  providers: [TracingService],
  exports: [TracingService],
})
export class ObservabilityModule {}
