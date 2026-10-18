import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import SnowflakeId from 'snowflake-id';
import { KhOperationLog } from './entities/kh-operation-log.entity';
import type { CreateOperationLogDto } from './dto/create-operation-log.dto';
import type { QueryOperationLogDto } from './dto/query-operation-log.dto';

/** 快照字段长度上限（与 init.sql 的 VARCHAR 一致） */
const USER_NAME_MAX = 50;
const TARGET_TITLE_MAX = 200;
const DETAIL_MAX = 500;

/**
 * 操作日志服务（19 号工单）。
 *
 * 设计约束（详见工单「风险与待确认」）：
 * - **只依赖自身仓库**：不注入 UserService 取用户名（那会成环：AuthModule → OperationModule → AuthModule）。
 *   用户名由调用方从 `AuthUser` 传入，`record()` 内部完成快照拼接。
 * - **不加拦截器**：项目硬约定「不加拦截器 / 异常过滤器 / 响应包装」，且拦截器拿不到
 *   「改的是哪篇文档」「文档标题是什么」这类业务语义，仍要在 service 补字段，等于做两遍。
 * - **不走 MQ**：现有 MQ 消费失败仅记日志并 ack、无 DLQ 无重投，审计日志的可靠性要求
 *   不足以支撑再叠一层异步不确定性。
 */
@Injectable()
export class OperationService {
  private readonly logger = new Logger(OperationService.name);
  private readonly snowflake = new SnowflakeId();

  constructor(
    @InjectRepository(KhOperationLog)
    private readonly logRepo: Repository<KhOperationLog>,
  ) {}

  /**
   * 记录一条操作日志。
   *
   * ★ 铁律：本方法**绝不向调用方抛错** —— 日志写入失败不得阻塞业务主流程。
   * 业务成功但日志失败时会漏记一条，这是刻意的取舍（审计不要求强一致），
   * 漏记可通过 warn 日志排查。
   *
   * ⚠️ 调用时机：**必须在业务事务之外**。写在事务内的话，事务回滚会连日志一起丢；
   * 反过来「业务失败却记了一条成功日志」比漏记更误导。
   */
  async record(entry: CreateOperationLogDto): Promise<void> {
    try {
      await this.logRepo.insert({
        id: this.snowflake.generate(),
        user_id: entry.actor?.userId ?? null,
        user_name: clip(actorNameOf(entry), USER_NAME_MAX),
        action: entry.action,
        target_type: entry.target_type ?? null,
        target_id: entry.target_id ?? null,
        // 主动截断优于被动丢日志：VARCHAR 超长会抛 22001，那条日志就没了
        target_title: clip(entry.target_title, TARGET_TITLE_MAX),
        detail: clip(entry.detail, DETAIL_MAX),
      });
    } catch (err) {
      this.logger.warn(
        `操作日志写入失败 action=${entry.action} target=${entry.target_type ?? '-'}:${entry.target_id ?? '-'} err=${(err as Error).message}`,
      );
    }
  }

  /**
   * 分页查询（created_at DESC）。
   * 无需 JOIN：user_name / target_title 已是冗余快照 —— 这是冗余字段的直接收益。
   */
  async findAll(query: QueryOperationLogDto) {
    const { page = 1, pageSize = 20, action, user_id, target_type } = query;
    const qb = this.logRepo
      .createQueryBuilder('log')
      .orderBy('log.created_at', 'DESC')
      .addOrderBy('log.id', 'DESC');

    // 显式判 !== undefined（AGENTS.md 硬约定：0 / false 是合法值，真值判断会漏）
    if (action !== undefined) {
      qb.andWhere('log.action = :action', { action });
    }
    if (user_id !== undefined) {
      qb.andWhere('log.user_id = :userId', { userId: user_id });
    }
    if (target_type !== undefined) {
      qb.andWhere('log.target_type = :targetType', { targetType: target_type });
    }

    const [rows, total] = await qb
      .skip((page - 1) * pageSize)
      .take(pageSize)
      .getManyAndCount();

    return {
      list: rows.map((row) => this.toView(row)),
      total,
      page,
      pageSize,
    };
  }

  /**
   * 行 → 响应形状（snake_case 原样出参，字段映射交给前端 `src/api/adapters/operation.ts`）。
   * 雪花 ID 一律转字符串：bigint 经 pg 驱动虽已是 string，但显式归一可防未来换驱动时悄然引入精度丢失。
   */
  private toView(row: KhOperationLog) {
    return {
      id: String(row.id),
      user_id: row.user_id != null ? String(row.user_id) : null,
      user_name: row.user_name,
      action: row.action,
      target_type: row.target_type,
      target_id: row.target_id != null ? String(row.target_id) : null,
      target_title: row.target_title,
      detail: row.detail,
      created_at:
        row.created_at instanceof Date
          ? row.created_at.toISOString()
          : row.created_at,
    };
  }
}

/** 操作人显示名：real_name 优先，空串 / 全空白回落 username */
function actorNameOf(entry: CreateOperationLogDto): string | null {
  const actor = entry.actor;
  if (!actor) return null;
  const realName = actor.realName?.trim();
  if (realName) return realName;
  return actor.username?.trim() || null;
}

/** 按列宽截断（null / undefined 原样返回 null） */
function clip(value: string | null | undefined, max: number): string | null {
  if (value === null || value === undefined) return null;
  return value.length > max ? value.slice(0, max) : value;
}
