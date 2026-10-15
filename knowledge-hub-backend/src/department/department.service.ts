import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { FindOptionsWhere, Repository } from 'typeorm';
import SnowflakeId from 'snowflake-id';
import { KhDepartment } from './entities/kh-department.entity';
import { KhUser } from '../auth/entities/kh-user.entity';
import { CreateDepartmentDto } from './dto/create-department.dto';
import { UpdateDepartmentDto } from './dto/update-department.dto';
import { QueryDepartmentDto } from './dto/query-department.dto';
import { normalizeSnowflakeId } from '../common/utils/snowflake-id.util';
import type { AuthUser } from '../auth/interfaces/auth-user.interface';

/** 部门树最大层级（与 kh_folder 的 MAX_FOLDER_DEPTH 保持一致） */
const MAX_DEPTH = 3;
/** 向上回溯的防御上限（防脏数据成环导致死循环） */
const MAX_WALK = 32;
/** 根的哨兵父ID */
const ROOT_ID = '0';

/** 部门树节点（parent_id 原样带出，便于前端定位根与判断是否可删） */
export interface DepartmentTreeNode {
  id: string;
  dept_name: string;
  dept_code: string | null;
  parent_id: string;
  sort: number;
  status: number;
  children: DepartmentTreeNode[];
}

/**
 * 部门模块服务：部门 CRUD（树形，软删）
 * 雪花ID 应用侧生成；删除带「子部门 + 用户归属」双保护
 */
@Injectable()
export class DepartmentService {
    private readonly logger = new Logger(DepartmentService.name);
    private readonly snowflake = new SnowflakeId();

    constructor(
        @InjectRepository(KhDepartment)
        private readonly deptRepo: Repository<KhDepartment>,
        @InjectRepository(KhUser)
        private readonly userRepo: Repository<KhUser>,
    ) {}

    /**
     * 平铺部门列表（排序 sort ASC, created_at ASC）
     * 缺省只返启用部门（全站下拉的数据源）；all=true 返全部（管理页）
     */
    async findAll(query?: QueryDepartmentDto) {
        const where: FindOptionsWhere<KhDepartment> = { deleted: false };
        if (!query?.all) where.status = 1;
        return this.deptRepo.find({
            where,
            order: { sort: 'ASC', created_at: 'ASC' },
        });
    }

    /**
     * 组装部门树：parent_id='0' 为根，其余按 parent_id 挂到父节点的 children。
     *
     * 孤儿兜底：父节点被软删（或数据异常）时，子节点会「找不到父」——
     * 此时把它当根挂出而不是丢弃，避免管理页里部门静默消失、用户却还挂在上面。
     */
    async findTree(query?: QueryDepartmentDto): Promise<DepartmentTreeNode[]> {
        const rows = await this.findAll(query);
        const nodeById = new Map<string, DepartmentTreeNode>();
        for (const row of rows) {
            nodeById.set(String(row.id), {
                id: String(row.id),
                dept_name: row.dept_name,
                dept_code: row.dept_code,
                parent_id: String(row.parent_id),
                sort: row.sort,
                status: row.status,
                children: [],
            });
        }
        const roots: DepartmentTreeNode[] = [];
        for (const node of nodeById.values()) {
            const parent =
                node.parent_id === ROOT_ID ? undefined : nodeById.get(node.parent_id);
            if (parent) parent.children.push(node);
            else roots.push(node);
        }
        return roots;
    }

    /** 部门详情（未删），404 兜底 */
    async findOne(id: string) {
        return this.findByIdOrFail(id);
    }

    /**
     * 创建部门：parent_id 缺省 '0'（根）
     * 校验：父部门存在 + 层级不超上限；重名由部分唯一索引兜底（23505 → 409）
     */
    async create(dto: CreateDepartmentDto, user?: AuthUser) {
        const parentId = dto.parent_id ?? ROOT_ID;
        if (parentId !== ROOT_ID) {
            await this.findByIdOrFail(parentId); // 父部门不存在/已删 → 404
            const parentDepth = await this.depthOf(parentId);
            if (parentDepth >= MAX_DEPTH) {
                throw new BadRequestException(`部门层级不得超过 ${MAX_DEPTH} 层`);
            }
        }
        const id = this.snowflake.generate();
        try {
            await this.deptRepo.save(
                this.deptRepo.create({
                    id,
                    dept_name: dto.dept_name.trim(),
                    dept_code: dto.dept_code ?? null,
                    parent_id: parentId,
                    sort: dto.sort ?? 0,
                    status: dto.status ?? 1,
                    create_by: user?.userId ?? null,
                    update_by: user?.userId ?? null,
                }),
            );
        } catch (err) {
            // 并发兜底：命中部分唯一索引 uk_kh_department_name（23505）按冲突返回
            if (err?.code === '23505') {
                throw new ConflictException('部门名称已存在');
            }
            throw err;
        }
        this.logger.log(`部门创建成功 departmentId=${id} parent=${parentId}`);
        return this.findByIdOrFail(id);
    }

    /** 更新部门（改名 / 改编码 / 改排序 / 改状态），404 兜底 */
    async update(id: string, dto: UpdateDepartmentDto, user?: AuthUser) {
        const dept = await this.findByIdOrFail(id);
        if (dto.dept_name !== undefined) dept.dept_name = dto.dept_name.trim();
        if (dto.dept_code !== undefined) dept.dept_code = dto.dept_code;
        if (dto.sort !== undefined) dept.sort = dto.sort;
        if (dto.status !== undefined) dept.status = dto.status;
        dept.update_by = user?.userId ?? null;
        try {
            await this.deptRepo.save(dept);
        } catch (err) {
            if (err?.code === '23505') {
                throw new ConflictException('部门名称已存在');
            }
            throw err;
        }
        this.logger.log(`部门更新成功 departmentId=${dept.id}`);
        return this.findByIdOrFail(dept.id);
    }

    /**
     * 删除部门（软删）：双保护 —— 有子部门或有用户归属一律拒绝
     * 与 16 号工单的目录删除策略同款：拒绝而非级联，避免子部门与用户归属变孤儿
     */
    async remove(id: string) {
        const dept = await this.findByIdOrFail(id);

        const childCount = await this.deptRepo.count({
            where: { parent_id: dept.id, deleted: false },
        });
        if (childCount > 0) {
            throw new BadRequestException(`该部门下还有 ${childCount} 个子部门，请先删除子部门`);
        }

        const userCount = await this.userRepo.count({
            where: { department_id: dept.id, deleted: false },
        });
        if (userCount > 0) {
            throw new BadRequestException(`该部门下还有 ${userCount} 名用户，请先调整用户归属`);
        }

        await this.deptRepo.update({ id: dept.id }, { deleted: true });
        this.logger.log(`部门已删除（软删）departmentId=${dept.id}`);
        return { id: dept.id, message: '部门已删除' };
    }

    /** 依据 id 定位未删部门，不存在 → 404 */
    private async findByIdOrFail(id: string): Promise<KhDepartment> {
        const deptId = normalizeSnowflakeId(id, 'id');
        const dept = await this.deptRepo.findOne({
            where: { id: deptId, deleted: false },
        });
        if (!dept) {
            throw new NotFoundException(`部门 ${deptId} 不存在`);
        }
        return dept;
    }

    /** 向上回溯计算节点深度（根的直接子节点深度 = 1） */
    private async depthOf(deptId: string): Promise<number> {
        let depth = 0;
        let current: string = deptId;
        while (current !== ROOT_ID && depth <= MAX_WALK) {
            const node = await this.deptRepo.findOne({
                where: { id: current, deleted: false },
            });
            if (!node) break;
            depth += 1;
            current = node.parent_id;
        }
        return depth;
    }
}
