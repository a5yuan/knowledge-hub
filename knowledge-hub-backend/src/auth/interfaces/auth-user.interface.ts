/**
 * JWT 鉴权通过后挂载到 request.user 的用户信息
 * 由 JwtStrategy.validate 按 sub 实时重查数据库组装（角色新鲜，天然拦截禁用/删除用户）
 */
export interface AuthUser {
  /** 用户ID（雪花字符串） */
  userId: string;
  /** 登录用户名 */
  username: string;
  /** 真实姓名 / 显示名 */
  realName: string | null;
  /** 邮箱 */
  email: string | null;
  /** 头像 URL */
  avatar: string | null;
  /** 角色编码列表，如 ['ROLE_REVIEWER', 'ROLE_USER'] */
  roles: string[];
  /** 归属部门ID（18 号工单；可空——不强制所有用户归部门） */
  department_id?: string | null;
  /** 归属部门名称（18 号工单；联 kh_department 得出，无部门或部门已删为 null） */
  department_name?: string | null;
}

/** JWT payload（与流程图一致：sub 唯一标识 / type 区分用途 / exp 过期秒级时间戳） */
export interface JwtPayload {
  /** 用户ID（雪花字符串） */
  sub: string;
  username: string;
  /** token 用途：access 调业务接口 / refresh 仅用于换新 */
  type: 'access' | 'refresh';
}
