import { Entity, PrimaryColumn, Column, CreateDateColumn } from 'typeorm';
import { normalizeSnowflakeId } from '../../common/utils/snowflake-id.util';

/**
 * kh_role_permission 表映射（见 init-scripts/postgresql/init.sql#L121-127）
 * 角色-权限关联表：角色是权限的集合载体（图1 标准 RBAC 模型）
 */
@Entity('kh_role_permission')
export class KhRolePermission {
  /** 关联ID（雪花ID，预置数据见 init.sql） */
  @PrimaryColumn({
    type: 'bigint',
    transformer: {
      to: (value: string | number) => normalizeSnowflakeId(value, 'id'),
      from: (value: string) => value,
    },
  })
  id: string;

  /** 角色ID → kh_role.id */
  @Column({ type: 'bigint', nullable: false })
  role_id: string;

  /** 权限ID → kh_permission.id */
  @Column({ type: 'bigint', nullable: false })
  permission_id: string;

  /** 分配时间 */
  @CreateDateColumn({ type: 'timestamp' })
  created_at: Date;
}
