import { Entity, PrimaryColumn, Column, CreateDateColumn, UpdateDateColumn } from 'typeorm';
import { normalizeSnowflakeId } from '../../common/utils/snowflake-id.util';

/**
 * kh_folder 表映射（见 init-scripts/postgresql/init.sql，16 号工单）
 * 目录表（树形，按 zone 分区）：parent_id 支持树形组织，软删除
 *
 * zone 仅三值 mine / public / department —— archive 是文档状态（status=3）而非分区，不入本表
 */
@Entity('kh_folder')
export class KhFolder {
  /** 目录ID（雪花ID，应用侧生成） */
  @PrimaryColumn({
    type: 'bigint',
    transformer: {
      to: (value: string | number) => normalizeSnowflakeId(value, 'id'),
      from: (value: string) => value,
    },
  })
  id: string;

  /** 目录名称 */
  @Column({ type: 'varchar', length: 100, nullable: false })
  folder_name: string;

  /** 父目录 ID，0 为根（与 kh_team 一致，不用 NULL） */
  @Column({ type: 'bigint', default: 0 })
  parent_id: string;

  /** 分区：mine / public / department */
  @Column({ type: 'varchar', length: 20, nullable: false })
  zone: string;

  /** mine 分区归属用户 → kh_user.id */
  @Column({ type: 'bigint', nullable: true })
  owner_id: string | null;

  /** department 分区归属部门 → kh_department.id（18 号工单建表） */
  @Column({ type: 'bigint', nullable: true })
  department_id: string | null;

  /** 排序（同级内升序） */
  @Column({ type: 'int', default: 0 })
  sort: number;

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
