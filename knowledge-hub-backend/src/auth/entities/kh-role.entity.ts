import { Entity, PrimaryColumn, Column } from 'typeorm';
import { normalizeSnowflakeId } from '../../common/utils/snowflake-id.util';

/**
 * kh_role 表映射（见 init-scripts/postgresql/init.sql）
 * 角色表：预置 ROLE_ADMIN / ROLE_REVIEWER / ROLE_USER
 */
@Entity('kh_role')
export class KhRole {
  /** 角色ID（雪花ID，预置数据见 init.sql） */
  @PrimaryColumn({
    type: 'bigint',
    transformer: {
      to: (value: string | number) => normalizeSnowflakeId(value, 'id'),
      from: (value: string) => value,
    },
  })
  id: string;

  /** 角色名称（展示用） */
  @Column({ type: 'varchar', length: 50, nullable: false })
  role_name: string;

  /** 角色编码，如 ROLE_ADMIN / ROLE_REVIEWER / ROLE_USER */
  @Column({ type: 'varchar', length: 50, nullable: false, unique: true })
  role_code: string;

  /** 角色描述 */
  @Column({ type: 'varchar', length: 200, nullable: true })
  description: string | null;

  /** 账号状态：0 禁用 1 启用 */
  @Column({ type: 'smallint', default: 1 })
  status: number;
}
