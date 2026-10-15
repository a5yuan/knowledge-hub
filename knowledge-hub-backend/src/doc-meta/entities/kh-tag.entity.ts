import { Entity, PrimaryColumn, Column, CreateDateColumn, UpdateDateColumn } from 'typeorm';
import { normalizeSnowflakeId } from '../../common/utils/snowflake-id.util';

/**
 * kh_tag 表映射（17 号工单，见 init-scripts/postgresql/init.sql）
 * 文档标签字典（扁平）；use_count 是冗余引用计数，增删关联后按 kh_document_tag 重算
 */
@Entity('kh_tag')
export class KhTag {
  /** 标签ID（雪花ID，应用侧生成） */
  @PrimaryColumn({
    type: 'bigint',
    transformer: {
      to: (value: string | number) => normalizeSnowflakeId(value, 'id'),
      from: (value: string) => value,
    },
  })
  id: string;

  /** 标签名称（未删行唯一） */
  @Column({ type: 'varchar', length: 50, nullable: false })
  tag_name: string;

  /** 引用计数（冗余，供按热度排序；重算而非自增自减，避免异常路径漂移） */
  @Column({ type: 'int', default: 0 })
  use_count: number;

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
