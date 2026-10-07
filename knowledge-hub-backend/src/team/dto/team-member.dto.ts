import { IsIn, IsOptional, IsString } from 'class-validator';

/** 成员角色取值（kh_team_member.member_role） */
export const MEMBER_ROLES = ['leader', 'member'] as const;

/** 添加团队成员参数 */
export class AddTeamMemberDto {
  /** 成员用户ID → kh_user.id（必填） */
  @IsString()
  user_id: string;

  /** 成员角色（可选，默认 member） */
  @IsOptional()
  @IsIn(MEMBER_ROLES)
  member_role?: 'leader' | 'member';
}

/** 调整成员角色参数 */
export class UpdateMemberRoleDto {
  /** 目标角色（必填） */
  @IsIn(MEMBER_ROLES)
  member_role: 'leader' | 'member';
}
