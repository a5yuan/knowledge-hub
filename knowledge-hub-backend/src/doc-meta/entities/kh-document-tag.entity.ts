import { Entity, PrimaryColumn, Column, CreateDateColumn } from 'typeorm';
import { normalizeSnowflakeId } from '../../common/utils/snowflake-id.util';

/**
 * kh_document_tag 表映射（17 号工单，见 init-scripts/postgresql/init.sql）
 *
 * ⚠️ D 方案的唯一真相源：写侧只写本表，读侧只读本表。
 * 铁律 —— 任何读标签的代码路径都不允许解析 kh_document.tags 串（那只是派生值）。
 */
@Entity('kh_document_tag')
export class KhDocumentTag {
  /** 关联ID（雪花ID，应用侧生成） */
  @PrimaryColumn({
    type: 'bigint',
    transformer: {
      to: (value: string | number) => normalizeSnowflakeId(value, 'id'),
      from: (value: string) => value,
    },
  })
  id: string;

  /** 文档ID → kh_document.id */
  @Column({ type: 'bigint', nullable: false })
  document_id: string;

  /** 标签ID → kh_tag.id */
  @Column({ type: 'bigint', nullable: false })
  tag_id: string;

  /** 创建时间（决策 #5：与 kh_user_role / kh_role_permission 对齐） */
  @CreateDateColumn({ type: 'timestamp' })
  created_at: Date;
}
