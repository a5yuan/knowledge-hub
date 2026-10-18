import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { FindOptionsWhere, Repository } from 'typeorm';
import SnowflakeId from 'snowflake-id';
import { KhFolder } from './entities/kh-folder.entity';
import { KhDocument } from '../document/entities/document.entity';
import { CreateFolderDto } from './dto/create-folder.dto';
import { UpdateFolderDto } from './dto/update-folder.dto';
import { QueryFolderDto } from './dto/query-folder.dto';
import { normalizeSnowflakeId } from '../common/utils/snowflake-id.util';
import { OperationService } from '../operation/operation.service';
import type { AuthUser } from '../auth/interfaces/auth-user.interface';

/** 目录最大层级（与 18 号工单的部门树约束保持一致） */
const MAX_FOLDER_DEPTH = 3;
/** 向上回溯的防御上限（防脏数据成环导致死循环） */
const MAX_WALK = 32;

/**
 * 目录模块服务：目录 CRUD（软删）
 * 雪花ID 应用侧生成；删除带「子目录 + 文档挂载」双保护
 */
@Injectable()
export class FolderService {
    private readonly logger = new Logger(FolderService.name);
    private readonly snowflake = new SnowflakeId();

    constructor(
        @InjectRepository(KhFolder)
        private readonly folderRepo: Repository<KhFolder>,
        @InjectRepository(KhDocument)
        private readonly docRepo: Repository<KhDocument>,
        // 19 号工单：目录增删审计埋点
        private readonly operation: OperationService,
    ) {}

    /**
     * 按 zone（+ 可选 parent_id）查目录列表，排序 sort ASC, created_at ASC
     * 不传 parent_id 返回该分区全部未删目录 —— 前端 buildFolderTree 需要完整节点集才能建树
     */
    async findAll(query: QueryFolderDto) {
        const { zone, parent_id } = query;
        const where: FindOptionsWhere<KhFolder> = { zone, deleted: false };
        // 显式判 !== undefined：'0' 是合法父级（根），真值判断会漏
        if (parent_id !== undefined) where.parent_id = parent_id;
        return this.folderRepo.find({
            where,
            order: { sort: 'ASC', created_at: 'ASC' },
        });
    }

    /** 目录详情（未删），404 兜底 */
    async findOne(id: string) {
        return this.findByIdOrFail(id);
    }

    /**
     * 创建目录：parent_id 缺省 '0'（根）
     * 校验：父目录存在 + 同分区 + 层级不超上限
     */
    async create(dto: CreateFolderDto, user?: AuthUser) {
        const parentId = dto.parent_id ?? '0';
        if (parentId !== '0') {
            const parent = await this.findByIdOrFail(parentId);
            if (parent.zone !== dto.zone) {
                throw new BadRequestException('父目录与目标分区不一致');
            }
            const depth = await this.depthOf(parentId);
            if (depth >= MAX_FOLDER_DEPTH) {
                throw new BadRequestException(`目录层级最多 ${MAX_FOLDER_DEPTH} 层`);
            }
        }
        const id = this.snowflake.generate();
        await this.folderRepo.save(
            this.folderRepo.create({
                id,
                folder_name: dto.folder_name,
                parent_id: parentId,
                zone: dto.zone,
                // mine 分区归属当前登录用户；public/department 无个人归属
                owner_id: dto.zone === 'mine' ? (user?.userId ?? null) : null,
                department_id: null,
                sort: dto.sort ?? 0,
                create_by: user?.userId ?? null,
                update_by: user?.userId ?? null,
            }),
        );
        this.logger.log(`目录创建成功 folderId=${id} zone=${dto.zone} parent=${parentId}`);
        // 19 号工单：审计埋点
        await this.operation.record({
            action: 'folder-create',
            target_type: 'folder',
            target_id: id,
            target_title: dto.folder_name,
            detail: `创建目录（${dto.zone} 分区）`,
            actor: user,
        });
        return this.findByIdOrFail(id);
    }

    /** 更新目录（改名 / 改排序），404 兜底 */
    async update(id: string, dto: UpdateFolderDto, user?: AuthUser) {
        const folder = await this.findByIdOrFail(id);
        if (dto.folder_name !== undefined) folder.folder_name = dto.folder_name;
        if (dto.sort !== undefined) folder.sort = dto.sort;
        folder.update_by = user?.userId ?? null;
        await this.folderRepo.save(folder);
        this.logger.log(`目录更新成功 folderId=${folder.id}`);
        return this.findByIdOrFail(folder.id);
    }

    /**
     * 删除目录（软删）：双保护 —— 有子目录或有文档挂载一律拒绝
     * 目录树最典型的坑是「删了父目录，子目录与文档全变孤儿」，这里拒绝而非级联
     */
    async remove(id: string, user?: AuthUser) {
        const folder = await this.findByIdOrFail(id);

        const childCount = await this.folderRepo.count({
            where: { parent_id: folder.id, deleted: false },
        });
        if (childCount > 0) {
            throw new BadRequestException(`该目录下还有 ${childCount} 个子目录，请先删除子目录`);
        }

        const docCount = await this.docRepo.count({
            where: { folder_id: folder.id, deleted: false },
        });
        if (docCount > 0) {
            throw new BadRequestException(`该目录下还有 ${docCount} 篇文档，请先移出`);
        }

        await this.folderRepo.update({ id: folder.id }, { deleted: true });
        this.logger.log(`目录已删除（软删）folderId=${folder.id}`);
        // 19 号工单：审计埋点（名称取自软删前已加载的实体）
        await this.operation.record({
            action: 'folder-delete',
            target_type: 'folder',
            target_id: folder.id,
            target_title: folder.folder_name,
            detail: `删除目录 ${folder.folder_name}`,
            actor: user,
        });
        return { id: folder.id, message: '目录已删除' };
    }

    /** 依据 id 定位未删目录，不存在 → 404 */
    private async findByIdOrFail(id: string): Promise<KhFolder> {
        const folderId = normalizeSnowflakeId(id, 'id');
        const folder = await this.folderRepo.findOne({
            where: { id: folderId, deleted: false },
        });
        if (!folder) {
            throw new NotFoundException(`目录 ${folderId} 不存在`);
        }
        return folder;
    }

    /** 向上回溯计算节点深度（根的直接子节点深度 = 1） */
    private async depthOf(folderId: string): Promise<number> {
        let depth = 0;
        let current: string = folderId;
        while (current !== '0' && depth <= MAX_WALK) {
            const node = await this.folderRepo.findOne({
                where: { id: current, deleted: false },
            });
            if (!node) break;
            depth += 1;
            current = node.parent_id;
        }
        return depth;
    }
}
