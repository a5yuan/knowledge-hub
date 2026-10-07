import { Entity, PrimaryColumn, Column, CreateDateColumn, UpdateDateColumn } from 'typeorm';
import { normalizeSnowflakeId } from '../../common/utils/snowflake-id.util';

/**
 * kh_permission 表映射（见 init-scripts/postgresql/init.sql#L104-119）
 * 权限表（RBAC）：树形结构（parent_id），permission_type 区分三级权限
 * 1 菜单（前端渲染菜单）/ 2 按钮（前端控制按钮显隐）/ 3 接口（URL 模式拦截，本期预留）
 * 运行时校验统一按 permission_code（全表 UNIQUE，一码一行，接口级复用按钮级码）
 */
@Entity('kh_permission')
export class KhPermission {
  /** 权限ID（雪花ID，预置数据见 init.sql） */
  @PrimaryColumn({
    type: 'bigint',
    transformer: {
      to: (value: string | number) => normalizeSnowflakeId(value, 'id'),
      from: (value: string) => value,
    },
  })
  id: string;

  /** 父权限ID，0 为根 */
  @Column({ type: 'bigint', default: 0 })
  parent_id: string;

  /** 权限名称（展示用） */
  @Column({ type: 'varchar', length: 50, nullable: false })
  permission_name: string;

  /** 权限编码（运行时校验，如 document:create，全表唯一） */
  @Column({ type: 'varchar', length: 100, nullable: false, unique: true })
  permission_code: string;

  /** 权限类型：1 菜单 2 按钮 3 接口 */
  @Column({ type: 'smallint', nullable: false })
  permission_type: number;

  /** 菜单路径（type=1 用） */
  @Column({ type: 'varchar', length: 200, nullable: true })
  menu_url: string | null;

  /** 接口 URL 模式（type=3 用，本期预留） */
  @Column({ type: 'varchar', length: 500, nullable: true })
  api_url: string | null;

  /** HTTP 方法（type=3 用，本期预留） */
  @Column({ type: 'varchar', length: 10, nullable: true })
  method: string | null;

  /** 图标（前端菜单用，如 antd 图标组件名） */
  @Column({ type: 'varchar', length: 50, nullable: true })
  icon: string | null;

  /** 排序号（同级内升序） */
  @Column({ type: 'int', default: 0 })
  sort: number;

  /** 状态：0 禁用 1 启用（禁用的权限不参与运行时校验） */
  @Column({ type: 'smallint', default: 1 })
  status: number;

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
