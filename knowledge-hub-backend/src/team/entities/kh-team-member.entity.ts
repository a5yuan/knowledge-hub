import { Entity, PrimaryColumn, Column, CreateDateColumn } from 'typeorm';
import { normalizeSnowflakeId } from '../../common/utils/snowflake-id.util';

/**
 * kh_team_member 表映射（见 init-scripts/postgresql/init.sql#L204-211）
 * 团队成员关联表：UNIQUE(team_id, user_id)；member_role 仅 leader / member
 * 关联表无软删列：移除成员即硬删该行
 */
@Entity('kh_team_member')
export class KhTeamMember {
  /** 关联ID（雪花ID，应用侧生成） */
  @PrimaryColumn({
    type: 'bigint',
    transformer: {
      to: (value: string | number) => normalizeSnowflakeId(value, 'id'),
      from: (value: string) => value,
    },
  })
  id: string;

  /** 团队ID → kh_team.id */
  @Column({ type: 'bigint', nullable: false })
  team_id: string;

  /** 成员用户ID → kh_user.id */
  @Column({ type: 'bigint', nullable: false })
  user_id: string;

  /** 成员角色：leader / member */
  @Column({ type: 'varchar', length: 20, default: 'member' })
  member_role: string;

  /** 加入时间 */
  @CreateDateColumn({ type: 'timestamp' })
  created_at: Date;
}
