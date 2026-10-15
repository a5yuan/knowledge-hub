import { Entity, PrimaryColumn, Column, CreateDateColumn, UpdateDateColumn } from 'typeorm';
import { normalizeSnowflakeId } from '../../common/utils/snowflake-id.util';

/**
 * kh_department 表映射（见 init-scripts/postgresql/init.sql，18 号工单）
 * 部门表（树形，深度 ≤ 3）：parent_id 以 0 表根，软删除
 *
 * 字段命名与 kh_team（team_name / team_code）/ kh_folder（folder_name）保持一致：
 * 下划线前缀式 + parent_id 用 0 而非 NULL 表根
 */
@Entity('kh_department')
export class KhDepartment {
  /** 部门ID（雪花ID，应用侧生成） */
  @PrimaryColumn({
    type: 'bigint',
    transformer: {
      to: (value: string | number) => normalizeSnowflakeId(value, 'id'),
      from: (value: string) => value,
    },
  })
  id: string;

  /** 部门名称（未删部门内唯一，见部分唯一索引 uk_kh_department_name） */
  @Column({ type: 'varchar', length: 50, nullable: false })
  dept_name: string;

  /** 部门编码（可选，如 TECH / RD） */
  @Column({ type: 'varchar', length: 50, nullable: true })
  dept_code: string | null;

  /** 父部门 ID，0 为根（与 kh_team / kh_folder 一致，不用 NULL） */
  @Column({ type: 'bigint', default: 0 })
  parent_id: string;

  /** 同级排序（升序） */
  @Column({ type: 'int', default: 0 })
  sort: number;

  /** 状态：0 禁用 1 启用 */
  @Column({ type: 'smallint', default: 1 })
  status: number;

  /** 创建时间 */
  @CreateDateColumn({ type: 'timestamp' })
  created_at: Date;

  /** 更新时间 */
  @UpdateDateColumn({ type: 'timestamp' })
  updated_at: Date;

  /** 创建人ID */
  @Column({ type: 'bigint', nullable: true })
  create_by: string | null;

  /** 最后更新人ID */
  @Column({ type: 'bigint', nullable: true })
  update_by: string | null;

  /** 软删除标记 */
  @Column({ type: 'boolean', default: false })
  deleted: boolean;
}
