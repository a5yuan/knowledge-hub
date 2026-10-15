import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Brackets, In, Repository } from 'typeorm';
import * as bcrypt from 'bcryptjs';
import SnowflakeId from 'snowflake-id';
import { KhUser } from '../auth/entities/kh-user.entity';
import { KhRole } from '../auth/entities/kh-role.entity';
import { KhUserRole } from '../auth/entities/kh-user-role.entity';
import { KhDepartment } from '../department/entities/kh-department.entity';
import { ADMIN_ROLE_CODE } from '../auth/permission.service';
import { DEFAULT_ROLE_CODE } from '../auth/user.service';
import { CreateUserDto, type ManagedRole } from './dto/create-user.dto';
import { UpdateUserDto } from './dto/update-user.dto';
import { QueryUserDto } from './dto/query-user.dto';
import { toStatusCode } from './dto/user-status';
import { normalizeSnowflakeId } from '../common/utils/snowflake-id.util';
import type { AuthUser } from '../auth/interfaces/auth-user.interface';

const BCRYPT_COST = 10;
/** 内置超管用户名（禁止删除，避免把系统管成没人能管） */
const BUILTIN_ADMIN_USERNAME = 'admin';
/**
 * 管理端代建账号的缺省初始密码。
 *
 * 前端 `UserCreatePayload.password` 为可选，留空即走此值 —— 不这么做会建出「无法登录的死账号」。
 * ⚠️ 生产部署前应改为「强制设置密码」或「随机初始密码 + 强制首登改密」。
 */
const DEFAULT_INITIAL_PASSWORD = '123456';

/** /user 接口的响应行（snake_case 原样出参，映射交给前端 src/api/adapters/user.ts） */
export interface UserAdminView {
  id: string;
  username: string;
  real_name: string | null;
  email: string | null;
  avatar: string | null;
  /** 后端角色码原样带出，如 ['ROLE_ADMIN','ROLE_USER'] */
  roles: string[];
  department_id: string | null;
  department_name: string | null;
  /** kh_user.status 原值：0 禁用 1 启用 */
  status: number;
  created_at: Date;
}

/**
 * 用户模块服务（管理端 CRUD）。
 *
 * ⚠️ 类名刻意**不叫 `UserService`**：`src/auth/user.service.ts` 已有同名类（自助鉴权域）。
 * 两个不同模块的类同名，一旦误 auto-import 到错误的路径，编译期无感、运行期 DI 报错或行为错乱
 * —— 与 `rag/ai.controller.ts` vs `ai/ai.controller.ts` 不同（controller 不被别处注入，同名无害）。
 * 详见 AGENTS.md「命名陷阱」。
 */
@Injectable()
export class UserAdminService {
  private readonly logger = new Logger(UserAdminService.name);
  private readonly snowflake = new SnowflakeId();

  constructor(
    @InjectRepository(KhUser)
    private readonly userRepo: Repository<KhUser>,
    @InjectRepository(KhRole)
    private readonly roleRepo: Repository<KhRole>,
    @InjectRepository(KhUserRole)
    private readonly userRoleRepo: Repository<KhUserRole>,
    @InjectRepository(KhDepartment)
    private readonly deptRepo: Repository<KhDepartment>,
  ) {}

  /**
   * 分页查询用户（keyword / role / department_id / status 四筛选独立生效）。
   *
   * 固定 3 条附加 SQL（与页大小解耦，无 N+1）：
   * 1. 主查询（getManyAndCount）
   * 2. 角色：kh_user_role ⋈ kh_role 一次取全页角色码
   * 3. 部门：按去重后的 department_id 集合一次取部门名
   * 角色筛选额外 1 条（取 ROLE_ADMIN 的 user_id 集合，用于 IN / NOT IN）
   */
  async findAll(query: QueryUserDto) {
    const { page, pageSize, keyword, role, department_id, status } = query;
    const qb = this.userRepo
      .createQueryBuilder('u')
      .where('u.deleted = :deleted', { deleted: false });

    if (keyword !== undefined) {
      const kw = keyword.trim();
      if (kw !== '') {
        qb.andWhere(
          new Brackets((b) => {
            b.where('u.username LIKE :kw', { kw: `%${kw}%` }).orWhere(
              'u.real_name LIKE :kw',
              { kw: `%${kw}%` },
            );
          }),
        );
      }
    }

    // 显式判 !== undefined：空串是合法输入（前端下拉重置后传 ''），语义 = 仅未归属部门的用户
    if (department_id !== undefined) {
      if (department_id === '') qb.andWhere('u.department_id IS NULL');
      else qb.andWhere('u.department_id = :department_id', { department_id });
    }
    if (status !== undefined) {
      qb.andWhere('u.status = :status', { status: toStatusCode(status) });
    }

    if (role !== undefined) {
      const adminIds = await this.findAdminUserIds();
      if (role === 'admin') {
        // In([]) 会生成 IN (NULL) 恒假，这里直接短路返回空页（与 17 号工单同一坑）
        if (adminIds.length === 0) return { items: [], total: 0, page, pageSize };
        qb.andWhere('u.id IN (:...adminIds)', { adminIds });
      } else if (adminIds.length > 0) {
        qb.andWhere('u.id NOT IN (:...adminIds)', { adminIds });
      }
    }

    const [items, total] = await qb
      .orderBy('u.created_at', 'DESC')
      .skip((page - 1) * pageSize)
      .take(pageSize)
      .getManyAndCount();

    return { items: await this.toViews(items), total, page, pageSize };
  }

  /**
   * 创建用户：bcrypt 哈希密码 + 写 kh_user_role。
   * 管理端代建账号**不走邮件激活**（email_verified=1 / status 缺省 1），否则新建即无法登录。
   */
  async create(dto: CreateUserDto, operator?: AuthUser) {
    const username = dto.username.trim();
    const exists = await this.userRepo.findOne({
      where: { username, deleted: false },
    });
    if (exists) {
      throw new ConflictException('用户名已存在');
    }

    const departmentId = await this.resolveDepartmentId(dto.department_id);
    const role = await this.findRoleByFrontendRole(dto.role);

    const id = this.snowflake.generate();
    const password = dto.password ?? DEFAULT_INITIAL_PASSWORD;
    if (dto.password === undefined) {
      this.logger.warn(
        `创建用户未指定密码，已使用默认初始密码 userId=${id} username=${username}`,
      );
    }
    const hash = await bcrypt.hash(password, BCRYPT_COST);
    try {
      await this.userRepo.save(
        this.userRepo.create({
          id,
          username,
          password: hash,
          email: dto.email ? dto.email.toLowerCase() : null,
          real_name: dto.real_name ?? null,
          email_verified: 1,
          status: dto.status ?? 1,
          department_id: departmentId,
        }),
      );
    } catch (err) {
      // 并发兜底：命中部分唯一索引（23505）按冲突返回
      if (err?.code === '23505') {
        throw new ConflictException('用户名或邮箱已被使用');
      }
      throw err;
    }

    await this.userRoleRepo.save(
      this.userRoleRepo.create({
        id: this.snowflake.generate(),
        user_id: id,
        role_id: role.id,
      }),
    );
    this.logger.log(
      `用户创建成功 userId=${id} username=${username} role=${role.role_code} operator=${operator?.userId ?? '-'}`,
    );
    return this.viewOf(id);
  }

  /** 更新用户（资料 / 邮箱 / 角色 / 部门 / 状态 / 重置密码） */
  async update(id: string, dto: UpdateUserDto, operator?: AuthUser) {
    const target = await this.findByIdOrFail(id);

    if (dto.real_name !== undefined) target.real_name = dto.real_name;
    if (dto.email !== undefined) target.email = dto.email ? dto.email.toLowerCase() : null;
    if (dto.department_id !== undefined) {
      // 空串 → null（清空归属）：admin/Users.vue:91 在部门列表为空时会传 ''
      target.department_id = await this.resolveDepartmentId(dto.department_id);
    }
    if (dto.status !== undefined) target.status = dto.status;
    if (dto.password !== undefined) {
      // password 存在即视为重置：旧密码立即失效
      target.password = await bcrypt.hash(dto.password, BCRYPT_COST);
    }
    try {
      await this.userRepo.save(target);
    } catch (err) {
      if (err?.code === '23505') {
        throw new ConflictException('邮箱已被使用');
      }
      throw err;
    }

    if (dto.role !== undefined) {
      await this.syncRole(target.id, dto.role);
    }
    this.logger.log(
      `用户更新成功 userId=${target.id} pwdReset=${dto.password !== undefined} operator=${operator?.userId ?? '-'}`,
    );
    return this.viewOf(target.id);
  }

  /**
   * 删除用户（软删）：拒绝删自己、拒绝删内置 admin
   * 同时清理 kh_user_role —— 软删用户不应继续持有角色授权（防漏写 deleted 条件的查询放行）
   */
  async remove(id: string, operator: AuthUser) {
    const target = await this.findByIdOrFail(id);
    if (String(target.id) === String(operator.userId)) {
      throw new BadRequestException('不能删除自己的账号');
    }
    if (target.username === BUILTIN_ADMIN_USERNAME) {
      throw new BadRequestException('内置 admin 账号不允许删除');
    }
    await this.userRepo.manager.transaction(async (em) => {
      await em.update(KhUser, { id: target.id }, { deleted: true });
      await em.delete(KhUserRole, { user_id: target.id });
    });
    this.logger.log(`用户已删除（软删）userId=${target.id} operator=${operator.userId}`);
    return { id: String(target.id), message: '用户已删除' };
  }

  // ---------- 内部 ----------

  /** 组装单行视图（create / update 的返回值复用） */
  private async viewOf(id: string): Promise<UserAdminView> {
    const user = await this.findByIdOrFail(id);
    return (await this.toViews([user]))[0];
  }

  /**
   * 按当前折叠角色同步 kh_user_role（事务：删旧插新）。
   *
   * **折叠角色相同时直接跳过** —— 前端 `UserRole` 只有 admin/member，`ROLE_REVIEWER`
   * 被折叠为 member（有损）。若不加这道判断，「只改部门」的 PATCH 也会带上 role:'member'，
   * 从而把审核员的 ROLE_REVIEWER 一并删掉（静默丢权限）。
   */
  private async syncRole(userId: string, role: ManagedRole): Promise<void> {
    const currentRoles = await this.getRoleCodes(userId);
    const currentFolded: ManagedRole = currentRoles.includes(ADMIN_ROLE_CODE)
      ? 'admin'
      : 'member';
    if (currentFolded === role) return;

    const role_ = await this.findRoleByFrontendRole(role);
    await this.userRepo.manager.transaction(async (em) => {
      await em.delete(KhUserRole, { user_id: userId });
      await em.save(
        em.create(KhUserRole, {
          id: this.snowflake.generate(),
          user_id: userId,
          role_id: role_.id,
        }),
      );
    });
    this.logger.log(
      `用户角色已替换 userId=${userId} ${currentRoles.join('|') || '(空)'} → ${role_.role_code}`,
    );
  }

  /** 全页角色码批量取（1 条 SQL：kh_user_role ⋈ kh_role） */
  private async buildRolesByUser(userIds: string[]): Promise<Map<string, string[]>> {
    const map = new Map<string, string[]>();
    if (userIds.length === 0) return map;
    const rows = await this.userRoleRepo
      .createQueryBuilder('ur')
      .innerJoin(KhRole, 'r', 'r.id = ur.role_id AND r.status = 1')
      .select('ur.user_id', 'user_id')
      .addSelect('r.role_code', 'role_code')
      .where('ur.user_id IN (:...userIds)', { userIds })
      .getRawMany<{ user_id: string; role_code: string }>();
    for (const row of rows) {
      const key = String(row.user_id);
      const list = map.get(key) ?? [];
      list.push(row.role_code);
      map.set(key, list);
    }
    return map;
  }

  /** 全页部门名批量取（1 条 SQL，按去重后的 id 集合） */
  private async buildDeptNameById(
    deptIds: string[],
  ): Promise<Map<string, string>> {
    const map = new Map<string, string>();
    if (deptIds.length === 0) return map;
    const depts = await this.deptRepo.find({
      where: { id: In(deptIds) },
      select: { id: true, dept_name: true },
    });
    for (const d of depts) map.set(String(d.id), d.dept_name);
    return map;
  }

  /** kh_user 行 → /user 响应形状（角色/部门均为批量查得，调用方负责传入） */
  private async toViews(users: KhUser[]): Promise<UserAdminView[]> {
    if (users.length === 0) return [];
    const rolesByUser = await this.buildRolesByUser(users.map((u) => String(u.id)));
    const deptIds = [
      ...new Set(
        users
          .map((u) => u.department_id)
          .filter((v): v is string => v !== null && v !== undefined && v !== '')
          .map((v) => String(v)),
      ),
    ];
    const deptNameById = await this.buildDeptNameById(deptIds);
    return users.map((u) => {
      const deptId = u.department_id != null ? String(u.department_id) : null;
      return {
        id: String(u.id),
        username: u.username,
        real_name: u.real_name,
        email: u.email,
        avatar: u.avatar,
        roles: rolesByUser.get(String(u.id)) ?? [],
        department_id: deptId,
        department_name: deptId ? (deptNameById.get(deptId) ?? null) : null,
        status: u.status,
        created_at: u.created_at,
      };
    });
  }

  /** 取用户启用状态的角色码（与 auth/user.service.getRoleCodes 同语义） */
  private async getRoleCodes(userId: string): Promise<string[]> {
    const links = await this.userRoleRepo.find({ where: { user_id: userId } });
    if (links.length === 0) return [];
    const roles = await this.roleRepo.find({
      where: { id: In(links.map((l) => String(l.role_id))), status: 1 },
    });
    return roles.map((r) => r.role_code);
  }

  /** 取含 ROLE_ADMIN 的用户 ID 集合（角色筛选用） */
  private async findAdminUserIds(): Promise<string[]> {
    const role = await this.roleRepo.findOne({
      where: { role_code: ADMIN_ROLE_CODE, status: 1 },
    });
    if (!role) return [];
    const links = await this.userRoleRepo.find({ where: { role_id: role.id } });
    return links.map((l) => String(l.user_id));
  }

  /** 前端语义角色 → kh_role 行（默认角色未初始化时 409，给出可排查的提示） */
  private async findRoleByFrontendRole(role: ManagedRole): Promise<KhRole> {
    const roleCode = role === 'admin' ? ADMIN_ROLE_CODE : DEFAULT_ROLE_CODE;
    const found = await this.roleRepo.findOne({ where: { role_code: roleCode } });
    if (!found) {
      throw new ConflictException(`角色 ${roleCode} 未初始化，请检查 kh_role 预置数据`);
    }
    return found;
  }

  /** 部门 ID 归一化：空串 / undefined → null；非空则校验存在 */
  private async resolveDepartmentId(raw?: string): Promise<string | null> {
    const deptId = raw?.trim();
    if (!deptId) return null;
    const dept = await this.deptRepo.findOne({
      where: { id: deptId, deleted: false },
    });
    if (!dept) {
      throw new BadRequestException(`部门 ${deptId} 不存在`);
    }
    return deptId;
  }

  /** 依据 id 定位未删用户，不存在 → 404 */
  private async findByIdOrFail(id: string): Promise<KhUser> {
    const userId = normalizeSnowflakeId(id, 'id');
    const user = await this.userRepo.findOne({
      where: { id: userId, deleted: false },
    });
    if (!user) {
      throw new NotFoundException(`用户 ${userId} 不存在`);
    }
    return user;
  }
}
