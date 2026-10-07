import { Entity, PrimaryColumn, Column, CreateDateColumn, UpdateDateColumn } from 'typeorm';
import { normalizeSnowflakeId } from '../../common/utils/snowflake-id.util';

/**
 * kh_ai_session 表映射（见 init-scripts/postgresql/init.sql#L241-249，二期工单 08）
 * AI 会话：一行一个会话，updated_at 随最新消息刷新（索引 user_id + updated_at DESC）
 */
@Entity('kh_ai_session')
export class KhAiSession {
  /** 会话ID（雪花ID） */
  @PrimaryColumn({
    type: 'bigint',
    transformer: {
      to: (value: string | number) => normalizeSnowflakeId(value, 'id'),
      from: (value: string) => value,
    },
  })
  id: string;

  /** 归属用户 → kh_user.id */
  @Column({ type: 'bigint', nullable: false })
  user_id: string;

  /** 会话标题（默认取首问前 20 字） */
  @Column({ type: 'varchar', length: 80, nullable: false })
  title: string;

  @CreateDateColumn({ type: 'timestamp' })
  created_at: Date;

  @UpdateDateColumn({ type: 'timestamp' })
  updated_at: Date;
}
