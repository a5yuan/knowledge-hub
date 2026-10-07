import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { MongooseModule } from '@nestjs/mongoose';
import { DocumentService } from './document.service';
import { DocumentController } from './document.controller';
import { KhDocument } from './entities/document.entity';
import { KhDocumentReview } from './entities/document-review.entity';
import { DocumentContent, DocumentContentSchema } from './schemas/document-content.schema';
import { FileModule } from '../file/file.module';
import { StorageModule } from '../storage/storage.module';
import { KgModule } from '../kg/kg.module';
import { TeamModule } from '../team/team.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([KhDocument, KhDocumentReview]),
    MongooseModule.forFeature([
      { name: DocumentContent.name, schema: DocumentContentSchema },
    ]),
    FileModule,
    StorageModule,
    KgModule,
    // 09 号工单：resolveVisibilityScope（列表/详情可见性过滤）
    TeamModule,
  ],
  controllers: [DocumentController],
  providers: [DocumentService],
})
export class DocumentModule {}
