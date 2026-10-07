import { Entity, PrimaryColumn, Column, CreateDateColumn } from 'typeorm';
import { normalizeSnowflakeId } from '../../common/utils/snowflake-id.util';

/**
 * kh_document_review 表映射（见 init-scripts/postgresql/init.sql#L27-L43）
 * 文档发布审核记录：一次「提审」一行；approve/reject 后 review_result 非空，不再出现在待办列表
 * 审核开关由 REVIEW_ENABLED 控制（true 时 /publish=提审）
 */
@Entity('kh_document_review')
export class KhDocumentReview {
  /** 审核记录ID（雪花ID，应用侧生成，字符串存储避免 bigint 精度丢失） */
  @PrimaryColumn({
    type: 'bigint',
    transformer: {
      to: (value: string | number) => normalizeSnowflakeId(value, 'id'),
      from: (value: string) => value,
    },
  })
  id: string;

  /** 被审文档ID → kh_document.id（雪花字符串） */
  @Column({
    type: 'bigint',
    transformer: {
      to: (value: string | number) => normalizeSnowflakeId(value, 'document_id'),
      from: (value: string) => value,
    },
  })
  document_id: string;

  /** 审核人ID；待审时为 NULL */
  @Column({ type: 'bigint', nullable: true })
  reviewer_id: string | null;

  /** 审核人姓名 */
  @Column({ type: 'varchar', nullable: true })
  reviewer_name: string | null;

  /** 审核结果：NULL=待审 1=通过 2=驳回 */
  @Column({ type: 'smallint', nullable: true })
  review_result: number | null;

  /** 审核意见（驳回必填） */
  @Column({ type: 'varchar', nullable: true })
  review_comment: string | null;

  /** 提审前文档 status（0 草稿 / 1 已发布） */
  @Column({ type: 'smallint' })
  before_status: number;

  /** 审核完成时间 */
  @Column({ type: 'timestamp', nullable: true })
  reviewed_at: Date | null;

  /** 提交审核时间 */
  @CreateDateColumn({ type: 'timestamp' })
  created_at: Date;
}
