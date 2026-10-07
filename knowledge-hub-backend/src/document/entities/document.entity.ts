import { Entity, PrimaryColumn, Column, CreateDateColumn, UpdateDateColumn } from 'typeorm';
import { normalizeSnowflakeId } from '../../common/utils/snowflake-id.util';

/**
 * kh_document 表映射（见 init-scripts/postgresql/init.sql）
 * 文档元数据表：正文内容存于 MongoDB document_content，本表仅存元数据
 */
@Entity('kh_document')
export class KhDocument {
  /**
   * 文档ID（雪花ID，应用侧生成，非数据库自增）
   * bigint 超出 JS 安全整数范围，以字符串存储避免精度丢失；写库前经 normalizeSnowflakeId 校验归一化
   */
  @PrimaryColumn({
    type: 'bigint',
    transformer: {
      to: (value: string | number) => normalizeSnowflakeId(value, 'id'),
      from: (value: string) => value,
    },
  })
  id: string;

  /** 文档标题 */
  @Column({ type: 'varchar', nullable: false })
  title: string;

  /** 正文ID：对应 MongoDB document_content 的 _id 字符串，唯一 */
  @Column({ type: 'varchar', unique: true, nullable: false })
  content_id: string;

  /** 文档摘要（搜索结果/列表页展示） */
  @Column({ type: 'varchar', nullable: true })
  summary: string | null;

  /** 所属分类ID */
  @Column({ type: 'bigint', nullable: true })
  category_id: string | null;

  /** 所属团队ID（知识库空间） */
  @Column({ type: 'bigint', nullable: true })
  team_id: string | null;

  /** 作者（创建人）ID */
  @Column({ type: 'bigint', nullable: true })
  author_id: string | null;

  /** 封面图 URL */
  @Column({ type: 'varchar', nullable: true })
  cover_image: string | null;

  /** 标签（逗号分隔或 JSON 字符串） */
  @Column({ type: 'varchar', nullable: true })
  tags: string | null;

  /** 文档状态：0=草稿, 1=已发布, 2=待审核, 3=已归档（流转见 .trae/documents/document-status-flow-review.md） */
  @Column({ type: 'smallint', default: 0 })
  status: number;

  /** 备注 */
  @Column({ type: 'varchar', nullable: true })
  remark: string | null;

  /** 浏览量 */
  @Column({ type: 'int', default: 0 })
  view_count: number;

  /** 点赞数 */
  @Column({ type: 'int', default: 0 })
  like_count: number;

  /** 评论数 */
  @Column({ type: 'int', default: 0 })
  comment_count: number;

  /** 收藏数 */
  @Column({ type: 'int', default: 0 })
  favourite_count: number;

  /** 正文字数统计 */
  @Column({ type: 'int', default: 0 })
  word_count: number;

  /** 发布时间（草稿状态为 NULL） */
  @Column({ type: 'timestamp', nullable: true })
  publish_time: Date | null;

  /** 是否公开可见 */
  @Column({ type: 'boolean', default: false })
  is_public: boolean;

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

  /** 逻辑删除标记 */
  @Column({ type: 'boolean', default: false })
  deleted: boolean;
}
