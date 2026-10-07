import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import {
  DocumentContent,
  DocumentContentSchema,
} from '../document/schemas/document-content.schema';
import { Neo4jService } from './neo4j.service';
import { ExtractionService } from './extraction.service';
import { KgService } from './kg.service';
import { KgPipelineService } from './kg-pipeline.service';
import { KgQueryController } from './kg-query.controller';
import { TeamModule } from '../team/team.module';

/** 知识图谱模块：KG 消费者（快照→分块→抽取→写 Neo4j）+ 图谱构建/删除服务 + 图谱检索 API */
@Module({
  imports: [
    MongooseModule.forFeature([
      { name: DocumentContent.name, schema: DocumentContentSchema },
    ]),
    // 09 号工单：kg/search docs 段可见性过滤
    TeamModule,
  ],
  controllers: [KgQueryController],
  providers: [Neo4jService, ExtractionService, KgService, KgPipelineService],
  exports: [KgService],
})
export class KgModule { }
