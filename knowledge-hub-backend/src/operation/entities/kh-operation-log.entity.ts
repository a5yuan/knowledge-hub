import { Entity, PrimaryColumn, Column, CreateDateColumn } from 'typeorm';
import { normalizeSnowflakeId } from '../../common/utils/snowflake-id.util';

/**
 * kh_operation_log 表映射（见 init-scripts/postgresql/init.sql，19 号工单）
 *
 * 审计日志：**仅追加**，无 updated_at、无 deleted、无 create_by/update_by。
 * - 无 `deleted`：审计表若允许软删，等于允许隐藏操作痕迹（本批工单唯一不带软删的表）
 * - 无 `create_by`：`user_id` 就是操作人，再存一份是冗余
 * - `user_name` / `target_title` 是刻意的冗余快照：读取不联表，且目标被删后日志仍可读
 */
@Entity('kh_operation_log')
export class KhOperationLog {
  /** 日志ID（雪花ID，应用侧生成） */
  @PrimaryColumn({
    type: 'bigint',
    transformer: {
      to: (value: string | number) => normalizeSnowflakeId(value, 'id'),
      from: (value: string) => value,
    },
  })
  id: string;

  /** 操作人 → kh_user.id（可空：系统动作） */
  @Column({ type: 'bigint', nullable: true })
  user_id: string | null;

  /** 操作人显示名（冗余快照，用户改名后历史日志保留「当时是谁」） */
  @Column({ type: 'varchar', length: 50, nullable: true })
  user_name: string | null;

  /** 动作类型：upload / update / delete / login / ai-ask / publish / ... */
  @Column({ type: 'varchar', length: 30, nullable: false })
  action: string;

  /** 目标类型：document / user / team / folder */
  @Column({ type: 'varchar', length: 30, nullable: true })
  target_type: string | null;

  /** 目标 ID（目标软删后仍保留原始 ID） */
  @Column({ type: 'bigint', nullable: true })
  target_id: string | null;

  /** 目标标题（冗余快照，目标删除后日志仍可读） */
  @Column({ type: 'varchar', length: 200, nullable: true })
  target_title: string | null;

  /** 明细描述 */
  @Column({ type: 'varchar', length: 500, nullable: true })
  detail: string | null;

  /** 记录时间（仅追加，不存在更新语义，故用 CreateDateColumn 而非 UpdateDateColumn） */
  @CreateDateColumn({ type: 'timestamp' })
  created_at: Date;
}
