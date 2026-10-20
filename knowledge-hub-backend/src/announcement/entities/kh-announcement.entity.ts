import { Column, Entity, PrimaryColumn } from 'typeorm';
import { normalizeSnowflakeId } from '../../common/utils/snowflake-id.util';

/**
 * kh_announcement 表映射（21 号工单）。
 *
 * ⚠️ 时间列（`publish_time` / `expire_time` / `created_at` / `updated_at`）**一律由 DB 侧写入**
 * （DDL 默认值或 SQL `NOW()`）。应用侧不要用 `new Date()` 赋值 —— 那会让列里混入本地字面，
 * 与库中其它 `created_at` 的 UTC 字面基准不一致（详见 `stats.service.ts` 的两套时钟说明）。
 *
 * 因此这里刻意**不用** `@CreateDateColumn` / `@UpdateDateColumn`：它们会在 insert 时自动填
 * `new Date()`。用普通 `@Column` 且不传值，才能让 DDL 的 `DEFAULT NOW()` 生效。
 */
@Entity('kh_announcement')
export class KhAnnouncement {
  /** 公告 ID（雪花，应用侧生成） */
  @PrimaryColumn({
    type: 'bigint',
    transformer: {
      to: (value: string | number) => normalizeSnowflakeId(value, 'id'),
      from: (value: string) => value,
    },
  })
  id: string;

  /** 公告标题 */
  @Column({ type: 'varchar', length: 200, nullable: false })
  title: string;

  /** 公告正文（TEXT：正文可能较长，且不在 MongoDB） */
  @Column({ type: 'text', nullable: false })
  content: string;

  /** 状态：0 停用 / 1 启用（前端 `enabled` 由它映射） */
  @Column({ type: 'smallint', nullable: false, default: 1 })
  status: number;

  /** 发布时间（NULL = 未发布；前台只展示已到发布时间的） */
  @Column({ type: 'timestamp', nullable: true })
  publish_time: Date | null;

  /** 过期时间（NULL = 长期有效） */
  @Column({ type: 'timestamp', nullable: true })
  expire_time: Date | null;

  /** 排序（升序，数值小的靠前） */
  @Column({ type: 'int', nullable: false, default: 0 })
  sort: number;

  /** 创建时间（DB `DEFAULT NOW()`，UTC 字面基准） */
  @Column({ type: 'timestamp', nullable: false })
  created_at: Date;

  /** 更新时间（DB `DEFAULT NOW()`；应用侧更新时显式 SET NOW()） */
  @Column({ type: 'timestamp', nullable: false })
  updated_at: Date;

  /** 创建人 */
  @Column({ type: 'bigint', nullable: true })
  create_by: string | null;

  /** 最后修改人 */
  @Column({ type: 'bigint', nullable: true })
  update_by: string | null;

  /** 软删标记 */
  @Column({ type: 'boolean', nullable: false, default: false })
  deleted: boolean;
}
