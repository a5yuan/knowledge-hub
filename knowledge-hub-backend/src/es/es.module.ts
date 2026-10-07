import { Global, Module } from '@nestjs/common';
import { EsService } from './es.service';
import { VectorIndexService } from './vector-index.service';
import { DocIndexService } from './doc-index.service';

/** 全局模块：pipeline 消费者（RAG / Search）与 search 检索接口复用 */
@Global()
@Module({
  providers: [EsService, VectorIndexService, DocIndexService],
  exports: [EsService, VectorIndexService, DocIndexService],
})
export class EsModule {}
