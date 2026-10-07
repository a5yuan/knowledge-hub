import { Entity, PrimaryColumn, Column, CreateDateColumn } from 'typeorm';
import { normalizeSnowflakeId } from '../../common/utils/snowflake-id.util';

/**
 * kh_ai_message 表映射（见 init-scripts/postgresql/init.sql#L251-260，二期工单 08）
 * AI 消息：role = user | assistant；sources JSONB 存引用（知识库 + Web）
 */
@Entity('kh_ai_message')
export class KhAiMessage {
  /** 消息ID（雪花ID） */
  @PrimaryColumn({
    type: 'bigint',
    transformer: {
      to: (value: string | number) => normalizeSnowflakeId(value, 'id'),
      from: (value: string) => value,
    },
  })
  id: string;

  /** 所属会话 → kh_ai_session.id（ON DELETE CASCADE） */
  @Column({ type: 'bigint', nullable: false })
  session_id: string;

  /** 消息角色：user / assistant */
  @Column({ type: 'varchar', length: 16, nullable: false })
  role: string;

  /** 消息正文（assistant 为 markdown 文本） */
  @Column({ type: 'text', nullable: false })
  content: string;

  /** 引用来源 JSONB：[{ kind: 'knowledge'|'web', title, ref? }] */
  @Column({ type: 'jsonb', nullable: true })
  sources: unknown;

  @CreateDateColumn({ type: 'timestamp' })
  created_at: Date;
}
