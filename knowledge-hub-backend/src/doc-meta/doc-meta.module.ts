import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CategoriesService } from './categories.service';
import { TagsService } from './tags.service';
import { CategoryController } from './category.controller';
import { TagController } from './tag.controller';
import { KhCategory } from './entities/kh-category.entity';
import { KhTag } from './entities/kh-tag.entity';
import { KhDocumentTag } from './entities/kh-document-tag.entity';
import { KhDocument } from '../document/entities/document.entity';

/**
 * 文档元数据字典模块（17 号工单）：分类 + 标签 + 文档标签关联
 *
 * 合并成一个模块的理由：两个字典与一张关联表共享同一批实体注入；
 * 拆开会导致 kh_document_tag 被两边同时操作。
 * KhDocument 跨模块 forFeature 注册（分类删除保护要统计引用），不 import DocumentModule（无循环依赖）。
 */
@Module({
  imports: [TypeOrmModule.forFeature([KhCategory, KhTag, KhDocumentTag, KhDocument])],
  controllers: [CategoryController, TagController],
  providers: [CategoriesService, TagsService],
  // 导出 TagsService 供 DocumentModule 维护标签关联（写侧唯一真相源）
  exports: [TagsService],
})
export class DocMetaModule {}
