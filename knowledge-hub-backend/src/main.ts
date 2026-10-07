import 'dotenv/config'; // 必须最先执行：Langfuse 初始化要求环境变量先于 SDK 就绪
import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { AppModule } from './app.module';
import { initTracing } from './observability/tracing';

async function bootstrap() {
  // 可观测：先启动 Langfuse tracing，再建应用（失败/未启用自动降级，不影响启动）
  initTracing();
  const app = await NestFactory.create(AppModule);
  // 全局校验：transform 启用 DTO @Type 转换（URL 字符串 → number/boolean）
  app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true }));
  await app.listen(process.env.PORT ?? 3000);
}
bootstrap();
