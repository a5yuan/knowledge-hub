import { Entity, PrimaryColumn, Column, CreateDateColumn, UpdateDateColumn } from 'typeorm';
import { normalizeSnowflakeId } from '../../common/utils/snowflake-id.util';

/**
 * kh_category 表映射（17 号工单，见 init-scripts/postgresql/init.sql）
 * 文档分类字典（扁平，不做层级）；category_code 供前端 Category.key（slug）
 */
@Entity('kh_category')
export class KhCategory {
  /** 分类ID（雪花ID，应用侧生成） */
  @PrimaryColumn({
    type: 'bigint',
    transformer: {
      to: (value: string | number) => normalizeSnowflakeId(value, 'id'),
      from: (value: string) => value,
    },
  })
  id: string;

  /** 分类名称（未删行唯一） */
  @Column({ type: 'varchar', length: 50, nullable: false })
  category_name: string;

  /** 分类编码（slug，未删行唯一；可空） */
  @Column({ type: 'varchar', length: 50, nullable: true })
  category_code: string | null;

  /** 排序（升序） */
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

  /** 软删除标记（部分唯一索引 WHERE deleted = false 的依据） */
  @Column({ type: 'boolean', default: false })
  deleted: boolean;
}
