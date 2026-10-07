import { Entity, PrimaryColumn, Column, CreateDateColumn } from 'typeorm';
import { normalizeSnowflakeId } from '../../common/utils/snowflake-id.util';

/**
 * kh_user_role 表映射（见 init-scripts/postgresql/init.sql）
 * 用户-角色关联表：注册时绑定默认角色 ROLE_USER
 */
@Entity('kh_user_role')
export class KhUserRole {
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

  /** 角色ID → kh_role.id */
  @Column({ type: 'bigint', nullable: false })
  role_id: string;

  /** 分配时间 */
  @CreateDateColumn({ type: 'timestamp' })
  created_at: Date;
}
