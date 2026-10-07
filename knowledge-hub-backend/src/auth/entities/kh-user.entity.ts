import { Entity, PrimaryColumn, Column, CreateDateColumn, UpdateDateColumn } from 'typeorm';
import { normalizeSnowflakeId } from '../../common/utils/snowflake-id.util';

/**
 * kh_user 表映射（见 init-scripts/postgresql/init.sql）
 * 用户表：登录凭据 + 显示信息，软删除
 */
@Entity('kh_user')
export class KhUser {
  /**
   * 用户ID（雪花ID，应用侧生成，非数据库自增）
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

  /** 登录用户名（未删除用户唯一，见部分唯一索引 uk_kh_user_username） */
  @Column({ type: 'varchar', length: 50, nullable: false })
  username: string;

  /** 密码（bcrypt 哈希，cost=10） */
  @Column({ type: 'varchar', length: 255, nullable: false })
  password: string;

  /** 邮箱（可选） */
  @Column({ type: 'varchar', length: 100, nullable: true })
  email: string | null;

  /** 真实姓名 / 显示名 */
  @Column({ type: 'varchar', length: 50, nullable: true })
  real_name: string | null;

  /** 头像 URL */
  @Column({ type: 'varchar', length: 500, nullable: true })
  avatar: string | null;

  /** 邮箱验证标记：0 未验证 1 已验证 */
  @Column({ type: 'smallint', default: 1 })
  email_verified: number;

  /** 账号状态：0 禁用 1 启用 */
  @Column({ type: 'smallint', default: 1 })
  status: number;

  /** 最后登录时间 */
  @Column({ type: 'timestamp', nullable: true })
  last_login_at: Date | null;

  /** 创建时间 */
  @CreateDateColumn({ type: 'timestamp' })
  created_at: Date;

  /** 更新时间 */
  @UpdateDateColumn({ type: 'timestamp' })
  updated_at: Date;

  /** 软删除标记 */
  @Column({ type: 'boolean', default: false })
  deleted: boolean;
}
