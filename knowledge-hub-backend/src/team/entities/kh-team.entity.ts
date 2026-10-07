import { Entity, PrimaryColumn, Column, CreateDateColumn, UpdateDateColumn } from 'typeorm';
import { normalizeSnowflakeId } from '../../common/utils/snowflake-id.util';

/**
 * kh_team 表映射（见 init-scripts/postgresql/init.sql#L189-201）
 * 团队表（知识库空间载体）：parent_id 支持树形组织，软删除
 */
@Entity('kh_team')
export class KhTeam {
  /** 团队ID（雪花ID，应用侧生成） */
  @PrimaryColumn({
    type: 'bigint',
    transformer: {
      to: (value: string | number) => normalizeSnowflakeId(value, 'id'),
      from: (value: string) => value,
    },
  })
  id: string;

  /** 团队名称 */
  @Column({ type: 'varchar', length: 100, nullable: false })
  team_name: string;

  /** 团队编码（可选） */
  @Column({ type: 'varchar', length: 50, nullable: true })
  team_code: string | null;

  /** 描述 */
  @Column({ type: 'varchar', length: 500, nullable: true })
  description: string | null;

  /** 负责人 → kh_user.id（创建时缺省为建团人） */
  @Column({ type: 'bigint', nullable: true })
  leader_id: string | null;

  /** 父团队 ID，0 为根 */
  @Column({ type: 'bigint', default: 0 })
  parent_id: string;

  /** 排序（同级内升序） */
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

  /** 软删除标记 */
  @Column({ type: 'boolean', default: false })
  deleted: boolean;
}
