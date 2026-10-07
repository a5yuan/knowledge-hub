import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import {
  DocumentContent,
  DocumentContentSchema,
} from '../document/schemas/document-content.schema';
import { PipelineService } from './pipeline.service';
import { EmbeddingService } from './embedding.service';
import { SearchIndexService } from './search-index.service';

/** 流水线模块：RAG 消费者 + Search 消费者；MqService/DocIndexService 由全局模块提供 */
@Module({
  imports: [
    MongooseModule.forFeature([
      { name: DocumentContent.name, schema: DocumentContentSchema },
    ]),
  ],
  providers: [PipelineService, EmbeddingService, SearchIndexService],
})
export class PipelineModule { }
