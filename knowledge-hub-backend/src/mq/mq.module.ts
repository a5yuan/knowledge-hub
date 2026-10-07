import { Global, Module } from '@nestjs/common';
import { MqService } from './mq.service';

/** 全局模块：document 生产者与 pipeline 消费者共用同一连接 */
@Global()
@Module({
  providers: [MqService],
  exports: [MqService],
})
export class MqModule {}
