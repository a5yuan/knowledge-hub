import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { FolderService } from './folder.service';
import { FolderController } from './folder.controller';
import { KhFolder } from './entities/kh-folder.entity';
import { KhDocument } from '../document/entities/document.entity';

/**
 * 目录模块：目录 CRUD（树形，软删）
 * KhDocument 跨模块 forFeature 注册（删除时的文档挂载保护），不 import DocumentModule（无循环依赖）
 */
@Module({
    imports: [TypeOrmModule.forFeature([KhFolder, KhDocument])],
    controllers: [FolderController],
    providers: [FolderService],
    exports: [FolderService],
})
export class FolderModule {}
