import { Entity, PrimaryColumn, Column, CreateDateColumn } from 'typeorm';
import { normalizeSnowflakeId } from '../../common/utils/snowflake-id.util';

/**
 * kh_user_permission 表映射（见 init-scripts/postgresql/init.sql#L129-135）
 * 用户-权限关联表（直赋权限，图1 扩展能力）：作为角色权限的补充，
 * 满足临时性/特殊性权限需求，避免为个别需求新建角色；用户最终权限 = 角色权限 ∪ 直赋权限（去重合并）
 */
@Entity('kh_user_permission')
export class KhUserPermission {
  /** 关联ID（雪花ID，应用侧生成） */
  @PrimaryColumn({
    type: 'bigint',
    transformer: {
      to: (value: string | number) => normalizeSnowflakeId(value, 'id'),
      from: (value: string) => value,
    },
  })
  id: string;

  /** 用户ID → kh_user.id */
  @Column({ type: 'bigint', nullable: false })
  user_id: string;

  /** 权限ID → kh_permission.id */
  @Column({ type: 'bigint', nullable: false })
  permission_id: string;

  /** 分配时间 */
  @CreateDateColumn({ type: 'timestamp' })
  created_at: Date;
}
